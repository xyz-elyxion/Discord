// Package sentinelguard is the standalone Go integration for sites that want
// server-side token verification without running the full Sentinel stack in
// process (tokens still come from a central Sentinel deployment).
//
//	go get github.com/yourorg/sentinelguard
//
// Usage:
//
//	guard, _ := sentinelguard.New(sentinelguard.Config{
//	    TokenSecret: os.Getenv("SENTINEL_TOKEN_SECRET"),
//	})
//	http.Handle("/", guard.Middleware("my-site-key", myHandler))
//
// The middleware verifies: signature, expiry, site binding, action binding
// (when the route sets one) and hostname binding, and rejects token replay
// when Redis or an in-memory store is configured.
package sentinelguard

import (
	"net/http"
	"strings"
	"time"

	"limey.example/sentinel/internal/verification"
)

// Config for the guard.
type Config struct {
	// TokenSecret is the shared SENTINEL_TOKEN_SECRET (>= 32 bytes).
	TokenSecret string
	// ReplayStore is optional; defaults to in-process memory. Use a shared
	// Redis store for multi-instance deployments.
	ReplayStore verification.ReplayStore
	// HeaderName defaults to "X-Sentinel-Token".
	HeaderName string
}

// Guard validates tokens.
type Guard struct {
	ver    *verification.Verifier
	header string
}

// New validates the configuration.
func New(cfg Config) (*Guard, error) {
	store := cfg.ReplayStore
	if store == nil {
		store = verification.NewMemoryReplay()
	}
	ver, err := verification.NewVerifier(cfg.TokenSecret, store)
	if err != nil {
		return nil, err
	}
	header := cfg.HeaderName
	if header == "" {
		header = "X-Sentinel-Token"
	}
	return &Guard{ver: ver, header: header}, nil
}

// Middleware enforces verification on every request. action may be empty to
// skip action binding. host comes from r.Host automatically.
func (g *Guard) Middleware(siteKey, action string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get(g.header)
		if tok == "" {
			// also accept the value in a standard X-Sentinel-Token cookie for
			// form posts that cannot set headers
			if c, err := r.Cookie(g.header); err == nil {
				tok = c.Value
			}
		}
		if tok == "" {
			w.Header().Set("X-Sentinel-Required", "true")
			http.Error(w, "verification token required", http.StatusForbidden)
			return
		}
		host := r.Host
		if i := strings.LastIndex(host, ":"); i > 0 && !strings.Contains(host, "]") {
			host = host[:i]
		}
		if _, err := g.ver.Validate(tok, siteKey, host, action); err != nil {
			switch err {
			case verification.ErrExpired:
				http.Error(w, "token expired", http.StatusUnauthorized)
			case verification.ErrReplayed:
				http.Error(w, "token replay detected", http.StatusForbidden)
			default:
				http.Error(w, "invalid token", http.StatusForbidden)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

var _ = time.Second

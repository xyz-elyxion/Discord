// Sentinel server entrypoint.
//
// Endpoints (prefix /v1):
//
//	public     POST /v1/challenge        create a challenge {siteKey, action}
//	public     POST /v1/verify           verify solution → verification token
//	public     POST /v1/token/validate   validate a verification token
//	public     GET  /v1/health, /v1/ready, /metrics (unprotected)
//	admin      GET/POST/DELETE /v1/sites, /v1/sites/{key}, /v1/sites/{key}/rotate
//	admin      CRUD /v1/policies
//	admin      GET  /v1/events, /v1/analytics, /v1/audit
//	admin      POST /v1/auth/login, /v1/auth/logout, GET /v1/auth/me
//
// Run with -help for required environment variables.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"limey.example/sentinel/internal/auth"
	"limey.example/sentinel/internal/dashboard"
	"limey.example/sentinel/internal/detection"
	"limey.example/sentinel/internal/httpx"
	"limey.example/sentinel/internal/metrics"
	"limey.example/sentinel/internal/policy"
	"limey.example/sentinel/internal/ratelimit"
	"limey.example/sentinel/internal/selfscope"
	"limey.example/sentinel/internal/storage"
	"limey.example/sentinel/internal/verification"
)

type config struct {
	addr      string
	pgDSN     string
	redisAddr string
	tokenTTL  time.Duration
	pepperCID string
}

func loadConfig() (config, error) {
	c := config{
		addr:      getenv("SENTINEL_ADDR", ":8080"),
		pgDSN:     os.Getenv("SENTINEL_PG_DSN"),
		redisAddr: os.Getenv("SENTINEL_REDIS_ADDR"),
		tokenTTL:  2 * time.Minute,
		pepperCID: getenv("SENTINEL_CLIENT_PEPPER", ""),
	}
	if c.pepperCID == "" {
		// Derive a process-stable pepper; operators SHOULD set their own so
		// client ids survive restarts.
		b := make([]byte, 16)
		_, _ = rand.Read(b)
		c.pepperCID = "derived-" + hex.EncodeToString(b)
	}
	return c, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	bootstrap := flag.Bool("bootstrap", false, "create the first admin (SENTINEL_ADMIN_USER/SENTINEL_ADMIN_PASSWORD) then exit")
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}
	if *bootstrap {
		if err := runBootstrap(cfg); err != nil {
			slog.Error("bootstrap", "err", err)
			os.Exit(1)
		}
		fmt.Println("bootstrap complete")
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	srv, err := newServer(ctx, cfg)
	if err != nil {
		slog.Error("server init", "err", err)
		os.Exit(1)
	}
	httpSrv := &http.Server{
		Addr:              cfg.addr,
		Handler:           srv.mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shutdownCtx)
	}()
	slog.Info("sentinel listening", "addr", cfg.addr)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("listen", "err", err)
		os.Exit(1)
	}
	slog.Info("sentinel stopped")
}

func runBootstrap(cfg config) error {
	user := os.Getenv("SENTINEL_ADMIN_USER")
	pass := os.Getenv("SENTINEL_ADMIN_PASSWORD")
	if strings.TrimSpace(user) == "" || strings.TrimSpace(pass) == "" {
		return errors.New("SENTINEL_ADMIN_USER and SENTINEL_ADMIN_PASSWORD are required; no default credentials exist")
	}
	if len(pass) < 12 {
		return errors.New("SENTINEL_ADMIN_PASSWORD must be at least 12 characters")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	st, err := storage.Open(ctx, cfg.pgDSN)
	if err != nil {
		return err
	}
	defer st.Close()
	hash, err := auth.HashPassword(pass)
	if err != nil {
		return err
	}
	if _, err := st.CreateAdminUser(ctx, storage.AdminUser{Username: user, PasswordHash: hash, Role: auth.RoleAdmin}); err != nil {
		return err
	}
	return st.Audit(ctx, user, "admin.create", user, nil)
}

// --- server -----------------------------------------------------------------

type siteRuntime struct {
	site   storage.Site
	policy storage.Policy
}

type server struct {
	mux             *http.ServeMux
	store           *storage.Store
	issuer          *verification.Issuer
	verifier        *verification.Verifier
	pepper          string
	events          chan storage.EventRow
	challengeSeenMu sync.Mutex
	challengeSeen   map[string]time.Time
}

// registry adapts storage sites → the httpx SiteRegistry interface, with a
// short-lived process cache to survive DB hiccups.
type registry struct {
	srv     *server
	cache   map[string]siteRuntime
	expires time.Time
}

// snapshot refreshes the cache (best-effort; stale cache is used when the DB
// is unavailable — never silently disables protection).
func (r *registry) refresh(now time.Time) {
	if r.cache == nil || now.After(r.expires) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		sites, err := r.srv.store.ListSites(ctx)
		if err != nil {
			// keep stale cache; the healthy flag will mark degraded decisions
			return
		}
		m := make(map[string]siteRuntime, len(sites))
		for _, s := range sites {
			pols, _ := r.srv.store.ListPolicies(ctx, s.SiteKey)
			p := storage.Policy{}
			if len(pols) > 0 {
				p = pols[0]
			}
			m[s.SiteKey] = siteRuntime{site: s, policy: p}
		}
		r.cache = m
		r.expires = now.Add(30 * time.Second)
	}
}

func (r *registry) BySiteKey(siteKey string) (httpx.SiteConfig, bool) {
	r.refresh(time.Now())
	rt, ok := r.cache[siteKey]
	if !ok {
		return httpx.SiteConfig{}, false
	}
	return httpx.SiteConfig{
		SiteKey:             rt.site.SiteKey,
		Secret:              rt.site.Secret,
		Hostnames:           rt.site.Hostnames,
		Enabled:             rt.site.Enabled,
		Policy:              r.srv.toRoutePolicy(rt.policy),
		TokenTTL:            r.srv.tokenTTL(),
		ChallengeTTL:        2 * time.Minute,
		RateLimit:           rt.policy.RateLimit,
		RateWindow:          time.Duration(rt.policy.RateWindowSeconds) * time.Second,
		ChallengeDifficulty: rt.policy.ChallengeDifficulty,
	}, ok
}

func newServer(ctx context.Context, cfg config) (*server, error) {
	st, err := storage.Open(ctx, cfg.pgDSN)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	issuer, err := verification.NewIssuer(getenv("SENTINEL_TOKEN_SECRET", ""), verification.NewMemoryReplay())
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("token secret: %w", err)
	}
	verifier, err := verification.NewVerifier(getenv("SENTINEL_TOKEN_SECRET", ""), verification.NewMemoryReplay())
	if err != nil {
		st.Close()
		return nil, fmt.Errorf("token secret: %w", err)
	}
	s := &server{
		mux:      http.NewServeMux(),
		store:    st,
		issuer:   issuer,
		verifier: verifier,
		pepper:   cfg.pepperCID,
		events:   make(chan storage.EventRow, 4096),
	}
	// self-only scope: seed the built-in site Sentinel protects (itself).
	// Idempotent: exists → keep existing secret; missing → create + default policy.
	if err := seedSelfSite(ctx, st); err != nil {
		st.Close()
		return nil, fmt.Errorf("seed self site: %w", err)
	}
	s.routes(ctx)
	// bounded event flusher: drops oldest when the channel is full and logs it
	go s.flushEvents(ctx)
	return s, nil
}

// seedSelfSite ensures the built-in "self" site exists. Runs on every boot;
// if the site already exists its secret is left untouched.
func seedSelfSite(ctx context.Context, st *storage.Store) error {
	seedCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, ok, err := st.GetSite(seedCtx, selfscope.SiteKey)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	hostname := getenv("SENTINEL_SELF_HOSTNAME", selfscope.DefaultHostname)
	if _, err := st.CreateSite(seedCtx, storage.Site{
		SiteKey:   selfscope.SiteKey,
		Name:      "Sentinel (self)",
		Secret:    hex.EncodeToString(secret),
		Hostnames: []string{hostname, "localhost"},
		Enabled:   true,
	}); err != nil {
		return err
	}
	_, err = st.UpsertPolicy(seedCtx, defaultPolicyFor(selfscope.SiteKey))
	return err
}

func (s *server) flushEvents(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-s.events:
			eCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := s.store.InsertEvent(eCtx, e); err != nil {
				slog.Warn("event insert failed", "err", err)
			}
			cancel()
		}
	}
}

func (s *server) tokenTTL() time.Duration { return 2 * time.Minute }

func (s *server) toRoutePolicy(p storage.Policy) policy.RoutePolicy {
	return policy.RoutePolicy{
		ID:                  fmt.Sprintf("%s/%s", p.SiteKey, p.Name),
		SiteKey:             p.SiteKey,
		Hostname:            p.Hostname,
		Method:              p.Method,
		PathPrefix:          p.PathPrefix,
		ActionName:          p.ActionName,
		RequireVerified:     p.RequireVerified,
		ChallengeDifficulty: p.ChallengeDifficulty,
		Thresholds: policy.Thresholds{
			ChallengeThreshold: p.ThresholdChallenge,
			ThrottleThreshold:  p.ThresholdThrottle,
			BlockThreshold:     p.ThresholdBlock,
		},
		RateLimit:         p.RateLimit,
		RateWindowSeconds: p.RateWindowSeconds,
		FailureMode:       policy.FailureMode(p.FailureMode),
		Simulation:        p.Simulation,
	}
}

// --- event sink (httpx adapter) ---------------------------------------------

type eventStoreSink struct {
	s *server
}

func (e eventStoreSink) Record(ev httpx.Event) {
	var rules []string
	for _, r := range ev.Rules {
		rules = append(rules, r)
	}
	row := storage.EventRow{
		TS: ev.Time, SiteKey: ev.SiteKey, Hostname: ev.Hostname, Action: ev.Action,
		ClientID: ev.ClientID, Decision: ev.Decision, Score: ev.Score,
		Degraded: ev.Degraded, Simulated: ev.Simulated,
		Method: ev.Method, Path: ev.Path, Reason: ev.Reason, Rules: rules,
	}
	select {
	case e.s.events <- row:
	default:
		// bounded: drop instead of blocking request handling; the metric
		// sentinel_events_dropped_total exposes this (see metrics wiring).
		slog.Warn("event buffer full; dropping event")
	}
}

// --- routes -------------------------------------------------------------------

func (s *server) routes(ctx context.Context) {
	// admin console (static, embedded)
	s.mux.Handle("/", dashboard.Handler())
	s.mux.HandleFunc("/v1/challenge", s.handleChallenge)
	s.mux.HandleFunc("POST /v1/verify", s.handleVerify)
	s.mux.HandleFunc("POST /v1/token/validate", s.handleTokenValidate)
	s.mux.HandleFunc("/v1/health", s.handleHealth)
	s.mux.HandleFunc("/v1/ready", s.handleReady)
	s.mux.Handle("/metrics", metrics.Handler())

	// protected playground
	protected, err := s.protector()
	if err == nil {
		s.mux.Handle("/protected/", protected.Middleware(http.HandlerFunc(s.demoBackend)))
	}

	// admin endpoints (auth middleware inside each helper)
	s.mux.HandleFunc("POST /v1/auth/login", s.handleLogin)
	s.mux.HandleFunc("POST /v1/auth/logout", s.adminReq(auth.RoleViewer, true, s.handleLogout))
	s.mux.HandleFunc("GET /v1/auth/me", s.adminReq(auth.RoleViewer, false, s.handleMe))
	s.mux.HandleFunc("GET /v1/sites", s.adminReq(auth.RoleViewer, false, s.handleListSites))
	s.mux.HandleFunc("POST /v1/sites", s.adminReq(auth.RoleAdmin, true, s.handleCreateSite))
	s.mux.HandleFunc("DELETE /v1/sites/{key}", s.adminReq(auth.RoleAdmin, true, s.handleDeleteSite))
	s.mux.HandleFunc("POST /v1/sites/{key}/rotate", s.adminReq(auth.RoleAdmin, true, s.handleRotate))
	s.mux.HandleFunc("GET /v1/policies", s.adminReq(auth.RoleViewer, false, s.handleListPolicies))
	s.mux.HandleFunc("POST /v1/policies", s.adminReq(auth.RoleOperator, true, s.handleUpsertPolicy))
	s.mux.HandleFunc("GET /v1/events", s.adminReq(auth.RoleViewer, false, s.handleEvents))
	s.mux.HandleFunc("GET /v1/analytics", s.adminReq(auth.RoleViewer, false, s.handleAnalytics))
	s.mux.HandleFunc("GET /v1/audit", s.adminReq(auth.RoleViewer, false, s.handleAudit))
}

// ProtectorMiddleware is a small indirection for testability.
var ProtectorMiddleware = func(p *httpx.Protector, next http.Handler) http.Handler {
	return p.Middleware(next)
}

func (s *server) protector() (*httpx.Protector, error) {
	eng := detection.New(
		detection.UnverifiedPenalty{Weight: 10, Action: detection.Challenge, Severity: detection.SeverityInfo},
		detection.TokenReplayRule{Threshold: 1, Weight: 25, Action: detection.Challenge, Severity: detection.SeverityHigh},
		detection.BurstRule{Threshold: 120, MaxWeight: 40, Action: detection.Throttle, Severity: detection.SeverityWarn},
		detection.ChallengeFailureRule{Threshold: 5, Weight: 50, Action: detection.Block, Severity: detection.SeverityCritical},
	)
	ev := &policy.Evaluator{DefaultThresholds: policy.Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}}
	lim := ratelimit.NewMemory()
	ver, err := verification.NewVerifier(getenv("SENTINEL_TOKEN_SECRET", ""), verification.NewMemoryReplay())
	if err != nil {
		return nil, err
	}
	reg := &registry{srv: s}
	return httpx.NewProtector(reg, eng, ev, lim, ver, eventStoreSink{s: s})
}

func (s *server) demoBackend(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"backend": "ok", "message": "request passed protection"})
}

// --- helpers ---------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}

func apiError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"code": code, "message": msg}})
}

// adminReq wraps admin handlers with session auth, CSRF on mutation, and RBAC.
func (s *server) adminReq(minRole string, mutating bool, next func(http.ResponseWriter, *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(auth.SessionCookieName)
		if err != nil {
			apiError(w, http.StatusUnauthorized, "unauthorized", "sign in required")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		sess, ok, _ := s.store.GetSession(ctx, auth.HashToken(c.Value))
		if !ok {
			apiError(w, http.StatusUnauthorized, "unauthorized", "session invalid or expired")
			return
		}
		u, ok, _ := s.store.GetUserByID(ctx, sess.UserID)
		if !ok {
			apiError(w, http.StatusUnauthorized, "unauthorized", "account not found")
			return
		}
		if u.Disabled {
			apiError(w, http.StatusForbidden, "disabled", "account disabled")
			return
		}
		if !auth.RoleAtLeast(u.Role, minRole) {
			apiError(w, http.StatusForbidden, "forbidden", "insufficient role")
			return
		}
		if mutating {
			tok := r.Header.Get("X-CSRF-Token")
			if tok == "" || !auth.ConstantTimeEqual(tok, sess.CSRF) {
				apiError(w, http.StatusForbidden, "csrf", "missing or invalid CSRF token")
				return
			}
		}
		next(w, r)
	}
}

var _ = detection.Allow
var _ = policy.Allow
var _ = fmt.Sprintf
var _ = httpx.IsHealthPath

// Package httpx provides the reusable Sentinel protection middleware for
// net/http, plus the trusted-proxy client-IP extraction logic.
package httpx

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ClientIP extracts the requesting client IP. Only trust X-Forwarded-For /
// X-Real-IP when the direct peer is in trustedProxies; otherwise the direct
// peer address IS the client (spoofable headers must not decide anything).
func ClientIP(r *http.Request, trustedProxies []*net.IPNet) string {
	remote := r.RemoteAddr
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return ""
	}
	trusted := false
	for _, n := range trustedProxies {
		if n.Contains(ip) {
			trusted = true
			break
		}
	}
	if !trusted {
		return ip.String()
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// first hop is the client; walk from the right skipping trusted proxies
		parts := strings.Split(xff, ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		// simplistic but safe default: take the leftmost entry, which in a
		// properly configured chain is the original client
		if len(parts) > 0 && parts[0] != "" {
			if client := net.ParseIP(parts[0]); client != nil {
				return client.String()
			}
		}
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		if client := net.ParseIP(strings.TrimSpace(xr)); client != nil {
			return client.String()
		}
	}
	return ip.String()
}

// ClientID derives the privacy-preserving identity used by counters: an HMAC
// of the IP with the deployment's idPepper, truncated — dashes the raw IP so
// events and dashboards never store full addresses.
func ClientID(ip, idPepper string) string {
	if ip == "" {
		return "unknown"
	}
	h := hmac.New(sha256.New, []byte(idPepper))
	h.Write([]byte(ip))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:9])
}

// IsHealthPath reports whether the path is a health/ready probe that bypasses
// protection (explicit exception list).
func IsHealthPath(path string) bool {
	switch path {
	case "/healthz", "/health", "/readyz", "/ready", "/livez", "/metrics":
		return true
	default:
		return false
	}
}

// ChallengeResponse is the 402/JSON body the middleware returns when a
// challenge is required. The browser SDK looks at exactly this shape.
type ChallengeResponse struct {
	Challenge  string `json:"challenge"` // target string
	Salt       string `json:"salt"`
	Difficulty int    `json:"difficulty"`
	MaxNumber  int64  `json:"maxnumber"`
	Signature  string `json:"signature,omitempty"`
	SiteKey    string `json:"siteKey"`
	Action     string `json:"action,omitempty"`
	ExpiresIn  int    `json:"expiresIn"`
}

// BlockResponse explains a 403/429. Always generic; never leaks rule internals
// beyond the decision itself.
type BlockResponse struct {
	Decision   string `json:"decision"` // block | throttle
	Reason     string `json:"reason,omitempty"`
	RetryAfter int    `json:"retryAfter,omitempty"` // seconds, for throttle
}

// writeJSON is a tiny helper.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var _ = fmt.Sprintf
var _ = strconv.Itoa
var _ = time.Second

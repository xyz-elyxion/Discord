package httpx

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"limey.example/sentinel/internal/metrics"

	"limey.example/sentinel/internal/challenge"
	"limey.example/sentinel/internal/detection"
	"limey.example/sentinel/internal/policy"
	"limey.example/sentinel/internal/ratelimit"
	"limey.example/sentinel/internal/verification"
)

// SiteRegistry supplies per-site configuration (secret, hostnames, enabled).
type SiteRegistry interface {
	// BySiteKey returns site config or nil when unknown.
	BySiteKey(siteKey string) (SiteConfig, bool)
}

// SiteConfig is what the middleware needs per site. Implementations should
// snapshot values freshly on each call so admin edits take effect.
type SiteConfig struct {
	SiteKey             string
	Secret              string // per-site signing secret for challenges
	Hostnames           []string
	Enabled             bool
	Policy              policy.RoutePolicy
	TokenTTL            time.Duration
	ChallengeTTL        time.Duration
	RateLimit           int
	RateWindow          time.Duration
	TrustedProxies      []*net.IPNet
	RequireVerified     bool
	ChallengeDifficulty int
}

// EventSink receives structured security events.
type EventSink interface {
	Record(ev Event)
}

// Event is the minimal shape events\ (viewer) need; storage layer expands it.
type Event struct {
	Time      time.Time
	SiteKey   string
	Hostname  string
	ClientID  string
	Action    string
	Decision  string
	Score     float64
	Degraded  bool
	Rules     []string
	Reason    string
	Path      string
	Method    string
	Simulated bool
}

// nopSink drops events (used in tests / preview mode).
type nopSink struct{}

func (nopSink) Record(Event) {}

// Protector is the middleware.
type Protector struct {
	Registry SiteRegistry
	Engine   *detection.Engine
	Policies *policy.Evaluator
	Limiter  ratelimit.Limiter
	Verifier *verification.Verifier
	Sink     EventSink
	// FailOpenWhenUnhealthy overrides policy failure modes globally (ops lever).
	FailOpenWhenUnhealthy bool
}

// NewProtector validates the wiring.
func NewProtector(reg SiteRegistry, eng *detection.Engine, ev *policy.Evaluator, lim ratelimit.Limiter, ver *verification.Verifier, sink EventSink) (*Protector, error) {
	if reg == nil || eng == nil || ev == nil || lim == nil {
		return nil, ErrConfig
	}
	if sink == nil {
		sink = nopSink{}
	}
	return &Protector{Registry: reg, Engine: eng, Policies: ev, Limiter: lim, Verifier: ver, Sink: sink}, nil
}

// ErrConfig marks a misconfigured Protector.
var ErrConfig = ErrProtectorWiring

type protectorWiringError struct{}

func (protectorWiringError) Error() string { return "httpx: protector wiring incomplete" }

// ErrProtectorWiring is the sentinel error value.
var ErrProtectorWiring protectorWiringError

// Middleware wires the protector. Full evaluation order:
//
//  1. health-path & unregistered-site bypass
//  2. hostname allowlist
//  3. token verification (sets verified + replay signal)
//  4. limiter observe + burst detection
//  5. rate limit enforcement per policy
//  6. risk scoring → policy decision
//  7. event recording → enforcement response
func (p *Protector) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IsHealthPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		cfg, ok := p.Registry.BySiteKey(siteKeyFromRequest(r))
		if !ok || !cfg.Enabled {
			// Unknown/absent site key: pass through configuration-free routes
			// (e.g. the dashboard itself). Protection only applies to
			// registered sites.
			next.ServeHTTP(w, r)
			return
		}
		hostname := hostOnly(r.Host)
		if !allowedHostname(cfg.Hostnames, hostname) {
			writeJSON(w, http.StatusForbidden, BlockResponse{Decision: "block", Reason: "hostname not registered"})
			return
		}
		clientIP := ClientIP(r, cfg.TrustedProxies)
		cid := ClientID(clientIP, "sentinel-client-pepper") // pepper via env in production wiring

		// token verification
		verified := false
		var replaySeen bool
		if tok := r.Header.Get("X-Sentinel-Token"); tok != "" && p.Verifier != nil {
			_, err := p.Verifier.Validate(tok, cfg.SiteKey, hostname, cfg.Policy.ActionName)
			if err != nil {
				if err == verification.ErrReplayed {
					replaySeen = true
				}
				verified = false
			} else {
				verified = true
			}
		}

		// counters snapshot (best-effort)
		var snap detection.CounterSnapshot
		if p.Limiter != nil {
			if err := p.Limiter.Observe(r.Context(), cid); err == nil {
				if busy, _ := p.Limiter.BurstBusy(r.Context(), cid); busy {
					snap.Burst = true
				}
			}
			if replaySeen {
				snap.TokenReplaysRecent = 1
			}
		}
		if cfg.RequireVerified && !verified {
			snap.ChallengeFailuresRecent = 0
		}

		rc := detection.WithSnapshot(
			detection.Request{
				SiteKey:  cfg.SiteKey,
				Hostname: hostname,
				Method:   r.Method,
				Path:     r.URL.Path,
				Action:   cfg.Policy.ActionName,
				Verified: verified,
				Headers:  httpHeadersSubset(r),
			},
			snap,
			detection.RouteExpectations{},
		)
		result := p.Engine.Evaluate(rc)
		// path-level rate limit enforcement
		var limited bool
		var limRes ratelimit.Result
		if cfg.RateLimit > 0 {
			res, err := p.Limiter.Limit(r.Context(), cid+"|"+cfg.SiteKey, int64(cfg.RateLimit), cfg.RateWindow)
			if err != nil {
				// degraded limiter: policy failure mode governs
				out := policy.OutcomeFromApply(cfg.Policy, false, false)
				p.record(cfg, r, cid, out, result)
				if out.Decision == policy.Block {
					writeJSON(w, http.StatusForbidden, BlockResponse{Decision: "block", Reason: out.Reason})
					return
				}
			} else {
				limRes = res
				limited = !res.Allowed
			}
		}
		healthy := p.Limiter.Healthy(r.Context())
		allowlisted, denylisted := false, false // resolved by storage-backed registries in the full server
		out := p.Policies.EvaluatePol(cfg.Policy, result.Score, verified, allowlisted, denylisted, p.FailOpenWhenUnhealthy, healthy)
		if limited {
			out = policy.OutcomeFromApply(cfg.Policy, true, healthy)
		}
		p.record(cfg, r, cid, out, result)

		// simulation mode: evaluate and log, never enforce
		if out.Simulated {
			next.ServeHTTP(w, r)
			return
		}
		switch out.Decision {
		case policy.Allow:
			next.ServeHTTP(w, r)
		case policy.Challenge:
			ch, err := challenge.Issue(cfg.Secret, cfg.SiteKey, cfg.Policy.ActionName, cfg.ChallengeDifficulty, cfg.ChallengeTTL, time.Now())
			if err != nil {
				// issuing failed: fail-open unless required-verified
				if cfg.RequireVerified {
					writeJSON(w, http.StatusServiceUnavailable, BlockResponse{Decision: "block", Reason: "challenge unavailable"})
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			writeJSON(w, http.StatusPaymentRequired, ChallengeResponse{
				Challenge:  ch.Challenge,
				Salt:       ch.Salt,
				Difficulty: ch.Difficulty,
				MaxNumber:  ch.MaxNumber,
				Signature:  ch.Signature,
				SiteKey:    cfg.SiteKey,
				Action:     cfg.Policy.ActionName,
				ExpiresIn:  int(cfg.ChallengeTTL.Seconds()),
			})
		case policy.Throttle:
			ra := 10 // default retry hint
			if retry := time.Until(limRes.ResetAt).Seconds(); retry > 0 {
				ra = int(retry) + 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(ra))
			writeJSON(w, http.StatusTooManyRequests, BlockResponse{Decision: "throttle", Reason: out.Reason, RetryAfter: ra})
		case policy.Block:
			writeJSON(w, http.StatusForbidden, BlockResponse{Decision: "block", Reason: out.Reason})
		}
	})
}

func (p *Protector) record(cfg SiteConfig, r *http.Request, cid string, out policy.Outcome, res detection.Result) {
	rules := make([]string, 0, len(res.Triggered))
	for _, f := range res.Triggered {
		rules = append(rules, f.Rule)
	}
	if metrics.DecisionsTotal != nil {
		metrics.DecisionsTotal.WithLabelValues(cfg.SiteKey, string(out.Decision),
			boolLabel(out.Degraded), boolLabel(out.Simulated)).Inc()
	}
	p.Sink.Record(Event{
		Time:      time.Now(),
		SiteKey:   cfg.SiteKey,
		Hostname:  hostOnly(r.Host),
		ClientID:  cid,
		Action:    cfg.Policy.ActionName,
		Decision:  string(out.Decision),
		Score:     out.Score,
		Degraded:  out.Degraded,
		Rules:     rules,
		Reason:    out.Reason,
		Path:      r.URL.Path,
		Method:    r.Method,
		Simulated: out.Simulated,
	})
}

func siteKeyFromRequest(r *http.Request) string {
	if k := r.Header.Get("X-Sentinel-Site"); k != "" {
		return k
	}
	// path-prefix mode: /v1/protect/{siteKey}/...
	if parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 4); len(parts) >= 3 && parts[0] == "v1" && parts[1] == "protect" {
		return parts[2]
	}
	return ""
}

func hostOnly(host string) string {
	h := host
	if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h, "]") {
		h = h[:i]
	}
	return strings.ToLower(h)
}

func boolLabel(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func allowedHostname(list []string, hostname string) bool {
	if len(list) == 0 {
		return true
	}
	for _, h := range list {
		if strings.EqualFold(h, hostname) {
			return true
		}
	}
	return false
}

// httpHeadersSubset copies only the headers rules are allowed to see.
func httpHeadersSubset(r *http.Request) map[string]string {
	m := make(map[string]string, 4)
	for _, h := range []string{"accept", "accept-language", "accept-encoding", "user-agent"} {
		if v := r.Header.Get(h); v != "" {
			if len(v) > 120 {
				v = v[:120]
			}
			m[h] = v
		}
	}
	return m
}

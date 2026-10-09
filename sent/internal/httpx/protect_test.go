package httpx

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"limey.example/sentinel/internal/challenge"
	"limey.example/sentinel/internal/detection"
	"limey.example/sentinel/internal/policy"
	"limey.example/sentinel/internal/ratelimit"
	"limey.example/sentinel/internal/verification"
)

// --- fakes -----------------------------------------------------------------

type fakeRegistry map[string]SiteConfig

func (f fakeRegistry) BySiteKey(k string) (SiteConfig, bool) {
	c, ok := f[k]
	return c, ok
}

type memEvents struct {
	events []Event
}

func (m *memEvents) Record(ev Event) { m.events = append(m.events, ev) }

// --- helpers ---------------------------------------------------------------

const (
	siteKey     = "sk_test"
	siteSecret  = "0123456789abcdef0123456789abcdef"
	tokenSecret = "0123456789abcdef0123456789abcdef-0123456789abcdef"
)

func testConfig(mut func(*SiteConfig)) SiteConfig {
	c := SiteConfig{
		SiteKey:             siteKey,
		Secret:              siteSecret,
		Hostnames:           []string{"example.com"},
		Enabled:             true,
		Policy:              policy.RoutePolicy{ID: "p", SiteKey: siteKey, ActionName: "contact"},
		TokenTTL:            2 * time.Minute,
		ChallengeTTL:        2 * time.Minute,
		RateLimit:           100,
		RateWindow:          time.Minute,
		ChallengeDifficulty: challenge.MinDifficulty,
	}
	if mut != nil {
		mut(&c)
	}
	return c
}

func build(t *testing.T, cfg SiteConfig, replayStore verification.ReplayStore) (*Protector, *memEvents) {
	t.Helper()
	reg := fakeRegistry{siteKey: cfg}
	eng := detection.New(
		detection.UnverifiedPenalty{Weight: 10, Action: detection.Challenge, Severity: detection.SeverityInfo},
		detection.TokenReplayRule{Threshold: 1, Weight: 25, Action: detection.Challenge, Severity: detection.SeverityHigh},
	)
	ev := &policy.Evaluator{DefaultThresholds: policy.Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}}
	lim := ratelimit.NewMemory()
	if replayStore == nil {
		replayStore = verification.NewMemoryReplay()
	}
	ver, err := verification.NewVerifier(tokenSecret, replayStore)
	if err != nil {
		t.Fatal(err)
	}
	events := &memEvents{}
	p, err := NewProtector(reg, eng, ev, lim, ver, events)
	if err != nil {
		t.Fatal(err)
	}
	return p, events
}

func do(t *testing.T, p *Protector, mutate func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	h := p.Middleware(inner)
	req := httptest.NewRequest(http.MethodPost, "https://example.com/contact", nil)
	req.RemoteAddr = "203.0.113.10:4455"
	req.Header.Set("X-Sentinel-Site", siteKey)
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// --- tests -----------------------------------------------------------------

func TestHealthPathBypass(t *testing.T) {
	p, _ := build(t, testConfig(nil), nil)
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	h := p.Middleware(inner)
	req := httptest.NewRequest(http.MethodGet, "https://example.com/healthz", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("health path must bypass, got %d", rec.Code)
	}
}

func TestHostnameEnforcement(t *testing.T) {
	p, _ := build(t, testConfig(nil), nil)
	rec := do(t, p, func(r *http.Request) {
		r.Host = "evil.com"
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unregistered hostname should be blocked, got %d", rec.Code)
	}
}

func TestChallengeIssuedWhenUnverified(t *testing.T) {
	cfg := testConfig(func(c *SiteConfig) { c.Policy.RequireVerified = true })
	p, events := build(t, cfg, nil)
	rec := do(t, p, nil)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("expected 402 challenge, got %d body=%s", rec.Code, rec.Body.String())
	}
	var cr ChallengeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &cr); err != nil {
		t.Fatal(err)
	}
	if cr.SiteKey != siteKey || cr.Difficulty < challenge.MinDifficulty {
		t.Fatalf("challenge body: %+v", cr)
	}
	if len(events.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events.events))
	}
	if events.events[0].Decision != string(policy.Challenge) {
		t.Fatalf("decision = %s", events.events[0].Decision)
	}
}

func TestVerifiedTokenPasses(t *testing.T) {
	cfg := testConfig(func(c *SiteConfig) { c.Policy.RequireVerified = true })
	iss, err := verification.NewIssuer(tokenSecret, verification.NewMemoryReplay())
	if err != nil {
		t.Fatal(err)
	}
	tok, err := iss.Issue(verification.Payload{
		SiteKey:  siteKey,
		Action:   "contact",
		Hostname: "example.com",
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := build(t, cfg, nil)
	rec := do(t, p, func(r *http.Request) {
		r.Header.Set("X-Sentinel-Token", tok)
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("verified request should pass, got %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTokenReplayRejected(t *testing.T) {
	share := verification.NewMemoryReplay()
	cfg := testConfig(nil)
	iss, err := verification.NewIssuer(tokenSecret, share)
	if err != nil {
		t.Fatal(err)
	}
	tok, _ := iss.Issue(verification.Payload{SiteKey: siteKey, Action: "contact", Hostname: "example.com"}, time.Minute)
	p, events := build(t, cfg, share)

	// First request: passes
	rec := do(t, p, func(r *http.Request) { r.Header.Set("X-Sentinel-Token", tok) })
	if rec.Code != http.StatusOK {
		t.Fatalf("first use should pass, got %d", rec.Code)
	}
	// Replay: token invalid → the token_replay rule adds enough weight to cross
	// the challenge threshold (default engine weights + unverified penalty).
	rec = do(t, p, func(r *http.Request) { r.Header.Set("X-Sentinel-Token", tok) })
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("replayed token should trigger challenge, got %d", rec.Code)
	}
	if len(events.events) < 2 {
		t.Fatal("expected events for both requests")
	}
}

func TestSpoofedXFFIgnoredWithoutTrustedProxy(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.RemoteAddr = "198.51.100.7:1234"
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	got := ClientIP(req, nil)
	if got != "198.51.100.7" {
		t.Fatalf("spoofed XFF must be ignored, got %s", got)
	}
}

func TestTrustedProxyXFFRespected(t *testing.T) {
	_, proxyNet, _ := net.ParseCIDR("10.0.0.0/8")
	req := httptest.NewRequest(http.MethodGet, "http://example.com/", nil)
	req.RemoteAddr = "10.0.0.1:6000"
	req.Header.Set("X-Forwarded-For", "203.0.113.99")
	got := ClientIP(req, []*net.IPNet{proxyNet})
	if got != "203.0.113.99" {
		t.Fatalf("trusted proxy should honor XFF, got %s", got)
	}
}

func TestSimulationDoesNotEnforce(t *testing.T) {
	cfg := testConfig(func(c *SiteConfig) { c.Policy.Simulation = true; c.Policy.RequireVerified = true })
	p, events := build(t, cfg, nil)
	rec := do(t, p, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("simulation must not enforce, got %d", rec.Code)
	}
	if len(events.events) != 1 || !events.events[0].Simulated {
		t.Fatalf("simulated event expected: %+v", events.events)
	}
}

func TestThrottleResponse(t *testing.T) {
	cfg := testConfig(func(c *SiteConfig) {
		c.RateLimit = 1
		c.RateWindow = time.Minute
	})
	p, _ := build(t, cfg, nil)
	_ = do(t, p, nil) // consume the 1-slot quota
	rec := do(t, p, nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("Retry-After must be set on throttle")
	}
}

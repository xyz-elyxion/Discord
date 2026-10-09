package tests

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"limey.example/sentinel/internal/challenge"
	"limey.example/sentinel/internal/detection"
	"limey.example/sentinel/internal/httpx"
	"limey.example/sentinel/internal/policy"
	"limey.example/sentinel/internal/ratelimit"
	"limey.example/sentinel/internal/verification"
)

// in-memory registry (storage-free slice for E2E)
type memReg map[string]httpx.SiteConfig

func (m memReg) BySiteKey(k string) (httpx.SiteConfig, bool) { c, ok := m[k]; return c, ok }

const (
	secret = "0123456789abcdef0123456789abcdef"
	global = "0123456789abcdef0123456789abcdef-0123456789abcdef"
)

func solve(t *testing.T, p challenge.Parameters) string {
	t.Helper()
	for i := int64(0); i < 5_000_000; i++ {
		nonce := []byte(encodeInt(i))
		// hash contract: SHA256(salt || nonce), identical to internal/challenge
		h := sha256.New()
		h.Write([]byte(p.Salt))
		h.Write(nonce)
		if checkLeading(h.Sum(nil), nonce, p.Difficulty) {
			return base64.RawURLEncoding.EncodeToString(nonce)
		}
	}
	t.Fatal("no solution")
	return ""
}

func encodeInt(i int64) []byte { return []byte(itoa(i)) }

func itoa(i int64) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func checkLeading(digest, _ []byte, bits int) bool {
	for i := 0; i < bits/8; i++ {
		if digest[i] != 0 {
			return false
		}
	}
	if rem := bits % 8; rem != 0 {
		b := digest[bits/8]
		for i := 0; i < rem; i++ {
			if b&(1<<uint(7-i)) != 0 {
				return false
			}
		}
	}
	return true
}

func TestEndToEndChallengeFlow(t *testing.T) {
	cfg := httpx.SiteConfig{
		SiteKey: "e2e", Secret: secret, Hostnames: []string{"example.test"}, Enabled: true,
		Policy:              policy.RoutePolicy{ID: "p", SiteKey: "e2e", ActionName: "form", RequireVerified: true},
		ChallengeTTL:        time.Minute,
		ChallengeDifficulty: challenge.MinDifficulty,
	}
	reg := memReg{"e2e": cfg}
	eng := detection.New(detection.UnverifiedPenalty{Weight: 50, Action: detection.Challenge, Severity: detection.SeverityInfo})
	ev := &policy.Evaluator{DefaultThresholds: policy.Thresholds{ChallengeThreshold: 20, ThrottleThreshold: 50, BlockThreshold: 80}}
	lim := ratelimit.NewMemory()
	store := verification.NewMemoryReplay()
	issuer, err := verification.NewIssuer(global, store)
	if err != nil {
		t.Fatal(err)
	}
	ver, err := verification.NewVerifier(global, store)
	if err != nil {
		t.Fatal(err)
	}
	p, err := httpx.NewProtector(reg, eng, ev, lim, ver, nil)
	if err != nil {
		t.Fatal(err)
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("backend-reached"))
	})
	handler := p.Middleware(inner)

	// 1. unverified request → 402 + challenge
	req := httptest.NewRequest(http.MethodPost, "https://example.test/submit", nil)
	req.Header.Set("X-Sentinel-Site", "e2e")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("want 402, got %d", rec.Code)
	}
	var cr httpx.ChallengeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &cr); err != nil {
		t.Fatal(err)
	}
	params := challenge.Parameters{
		Challenge:  cr.Challenge,
		Salt:       cr.Salt,
		Difficulty: cr.Difficulty,
		Signature:  cr.Signature,
	}
	nonce := solve(t, params)
	chID, err := challenge.ID(cr.Challenge)
	if err != nil {
		t.Fatal(err)
	}

	// 2. token issuance after verification, direct via the APIs the server uses
	if err := challenge.Verify(params, nonce, secret, "e2e", "form", time.Now()); err != nil {
		t.Fatalf("verify: %v", err)
	}
	tok, err := issuer.Issue(verification.Payload{
		SiteKey: "e2e", Action: "form", Hostname: "example.test", Challenge: chID,
	}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// 3. verified request passes through
	req2 := httptest.NewRequest(http.MethodPost, "https://example.test/submit", nil)
	req2.Header.Set("X-Sentinel-Site", "e2e")
	req2.Header.Set("X-Sentinel-Token", tok)
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK || rec2.Body.String() != "backend-reached" {
		t.Fatalf("verified request should reach backend, got %d %s", rec2.Code, rec2.Body.String())
	}

	// 4. token replay is rejected by the middleware's verifier
	req3 := httptest.NewRequest(http.MethodPost, "https://example.test/submit", nil)
	req3.Header.Set("X-Sentinel-Site", "e2e")
	req3.Header.Set("X-Sentinel-Token", tok)
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusPaymentRequired {
		t.Fatalf("replayed token should not reach backend, got %d", rec3.Code)
	}

	// 5. cross-action binding rejected
	tokWrong, _ := issuer.Issue(verification.Payload{SiteKey: "e2e", Action: "other", Hostname: "example.test"}, time.Minute)
	req4 := httptest.NewRequest(http.MethodPost, "https://example.test/submit", nil)
	req4.Header.Set("X-Sentinel-Site", "e2e")
	req4.Header.Set("X-Sentinel-Token", tokWrong)
	rec4 := httptest.NewRecorder()
	handler.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusPaymentRequired {
		t.Fatalf("cross-action token should not pass, got %d", rec4.Code)
	}
}

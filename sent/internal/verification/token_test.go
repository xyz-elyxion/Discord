package verification

import (
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef-0123456789abcdef0123456789abcdef"

func newTestIssuer(t *testing.T, store ReplayStore) *Issuer {
	t.Helper()
	i, err := NewIssuer(testSecret, store)
	if err != nil {
		t.Fatalf("issuer: %v", err)
	}
	return i
}

func newTestVerifier(t *testing.T, store ReplayStore) *Verifier {
	t.Helper()
	v, err := NewVerifier(testSecret, store)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	return v
}

func TestIssueAndValidate(t *testing.T) {
	i := newTestIssuer(t, nil)
	v := newTestVerifier(t, nil)
	tok, err := i.Issue(Payload{SiteKey: "site1", Action: "contact", Hostname: "example.com"}, time.Minute)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	val, err := v.Validate(tok, "site1", "example.com", "contact")
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if val.Payload.SiteKey != "site1" || val.Action != "contact" || val.Hostname != "example.com" {
		t.Fatalf("unexpected validation: %+v", val)
	}
}

func TestValidateRejectsTampered(t *testing.T) {
	i := newTestIssuer(t, nil)
	v := newTestVerifier(t, nil)
	tok, _ := i.Issue(Payload{SiteKey: "site1"}, time.Minute)

	// tamper payload
	tampered := "AAAA" + tok[4:]
	if _, err := v.Validate(tampered, "site1", "", ""); err == nil {
		t.Fatal("expected tampered token to be rejected")
	}

	// tamper signature: flip a character that is definitely inside the sig part.
	// Signature is the last '.'-separated segment; replace two adjacent chars
	// in the MIDDLE of the sig segment with 'zz' (invalid base64url pair content)
	// while keeping payload intact.
	parts := strings.Split(tok, ".")
	if len(parts) != 2 {
		t.Fatalf("unexpected token shape")
	}
	sig := []byte(parts[1])
	mid := len(sig) / 2
	sig[mid] = 'z'
	sig[mid+1] = 'z'
	sigTampered := parts[0] + "." + string(sig)
	if _, err := v.Validate(sigTampered, "site1", "", ""); err == nil {
		t.Fatal("expected tampered signature to be rejected")
	}
}

func TestValidateRejectsExpired(t *testing.T) {
	issuer, err := NewIssuer(testSecret, nil)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := issuer.Issue(Payload{SiteKey: "site1"}, 0) // clamps to 2m default
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Forge a token whose expiry is in the past by re-signing a payload:
	// Test the Verifier's expiry check by hand-crafting an already-expired token.
	_ = tok
	v := newTestVerifier(t, nil)
	if _, err := v.Validate(expiredTokenForTest(), "site1", "", ""); err == nil {
		t.Fatal("expected expired token to be rejected")
	}
}

func TestValidateRejectsCrossSite(t *testing.T) {
	i := newTestIssuer(t, nil)
	v := newTestVerifier(t, nil)
	tok, _ := i.Issue(Payload{SiteKey: "site1"}, time.Minute)
	if _, err := v.Validate(tok, "site2", "", ""); err == nil {
		t.Fatal("expected cross-site rejection")
	}
}

func TestValidateRejectsCrossAction(t *testing.T) {
	i := newTestIssuer(t, nil)
	v := newTestVerifier(t, nil)
	tok, _ := i.Issue(Payload{SiteKey: "site1", Action: "contact"}, time.Minute)
	if _, err := v.Validate(tok, "site1", "", "login"); err == nil {
		t.Fatal("expected cross-action rejection")
	}
}

func TestValidateRejectsCrossHost(t *testing.T) {
	i := newTestIssuer(t, nil)
	v := newTestVerifier(t, nil)
	tok, _ := i.Issue(Payload{SiteKey: "site1", Hostname: "a.example.com"}, time.Minute)
	if _, err := v.Validate(tok, "site1", "b.example.com", ""); err == nil {
		t.Fatal("expected cross-host rejection")
	}
}

func TestReplayProtectionMemory(t *testing.T) {
	store := NewMemoryReplay()
	i := newTestIssuer(t, store)
	v := newTestVerifier(t, store)
	tok, _ := i.Issue(Payload{SiteKey: "site1"}, time.Minute)
	if _, err := v.Validate(tok, "site1", "", ""); err != nil {
		t.Fatalf("first use should validate: %v", err)
	}
	if _, err := v.Validate(tok, "site1", "", ""); err == nil {
		t.Fatal("replay should be rejected")
	}
}

func TestConcurrentReplay(t *testing.T) {
	store := NewMemoryReplay()
	i := newTestIssuer(t, store)
	v := newTestVerifier(t, store)
	tok, _ := i.Issue(Payload{SiteKey: "site1"}, time.Minute)
	const n = 32
	results := make(chan error, n)
	for k := 0; k < n; k++ {
		go func() {
			_, err := v.Validate(tok, "site1", "", "")
			results <- err
		}()
	}
	successes := 0
	for k := 0; k < n; k++ {
		if err := <-results; err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected exactly 1 successful concurrent validation, got %d", successes)
	}
}

func TestFuzzTokenParsing(t *testing.T) {
	i := newTestIssuer(t, nil)
	tok, _ := i.Issue(Payload{SiteKey: "s"}, time.Minute)
	bad := []string{
		"",
		".",
		"..",
		"a.b.c",
		strings.Repeat("A", MaxTokenLen+1),
		"AAAA.AAAA",
		tok + "x",
	}
	for _, b := range bad {
		v := newTestVerifier(t, nil)
		if _, err := v.Validate(b, "s", "", ""); err == nil {
			// Only a valid token would succeed; malformed ones should not.
			t.Fatalf("expected %q to be rejected", b)
		}
	}
}

func TestSecretTooShort(t *testing.T) {
	if _, err := NewIssuer("short", nil); err == nil {
		t.Fatal("expected short secret to be rejected")
	}
	if _, err := NewVerifier("short", nil); err == nil {
		t.Fatal("expected short verifier secret to be rejected")
	}
}

// expiredTokenForTest hand-crafts a validly-signed token with a past expiry.
// Issue honors a caller-supplied (clamped) expiry, so we can do this directly.
func expiredTokenForTest() string {
	iss, _ := NewIssuer(testSecret, nil)
	tok, _ := iss.Issue(Payload{SiteKey: "site1", ExpiresAt: time.Now().Add(-time.Hour).Unix()}, time.Minute)
	return tok
}

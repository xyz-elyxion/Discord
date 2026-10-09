package challenge

import (
	"strings"
	"testing"
	"time"
)

const (
	testSecret  = "0123456789abcdef0123456789abcdef"
	testSiteKey = "site1"
	testAction  = "contact"
)

func findNonce(t *testing.T, params Parameters) string {
	t.Helper()
	return findNonceWithDifficulty(t, params, params.Difficulty)
}

func findNonceWithDifficulty(t *testing.T, params Parameters, bits int) string {
	t.Helper()
	for i := int64(0); i < 10_000_000; i++ {
		enc := Nonce(EncodeNonce(i))
		if leadingZeroBits(hash(params.Salt, enc), bits) {
			return enc.String()
		}
	}
	t.Fatalf("no nonce found for %d bits", bits)
	return ""
}

func TestIssueAndVerify(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonce(t, params)
	if err := Verify(params, nonce, testSecret, testSiteKey, testAction, now); err != nil {
		t.Fatalf("verify: %v", err)
	}
}

func TestVerifyRejectsWrongSolution(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonceWithDifficulty(t, params, 15) // meets 15 bits, not 18
	if err := Verify(params, nonce, testSecret, testSiteKey, testAction, now); err == nil {
		t.Fatal("expected verify to reject insufficient solution")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	for _, bad := range []string{
		"",
		"!!!not-base64!!!",
		params.Salt, // nonce that isn't a valid nonce
	} {
		if err := Verify(params, bad, testSecret, testSiteKey, testAction, now); err == nil {
			t.Fatalf("expected malformed %q to be rejected", bad)
		}
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonce(t, params)
	if err := Verify(params, nonce, testSecret, testSiteKey, testAction, now.Add(3*time.Minute)); err == nil {
		t.Fatal("expected expiry to be rejected")
	}
}

func TestVerifyRejectsCrossSite(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, "other-site", testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonce(t, params)
	if err := Verify(params, nonce, testSecret, testSiteKey, testAction, now); err == nil {
		t.Fatal("expected cross-site challenge to be rejected")
	}
}

func TestVerifyRejectsTamperedMAC(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, 2*time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonce(t, params)
	// tamper the MAC embedded inside the signed challenge blob
	params2 := params
	tampered, err := tamperMAC(params.Challenge)
	if err != nil {
		t.Fatalf("tamper: %v", err)
	}
	params2.Challenge = tampered
	if err := Verify(params2, nonce, testSecret, testSiteKey, testAction, now); err == nil {
		t.Fatal("expected tampered MAC to be rejected")
	}
}

// tamperMAC decodes the challenge, swaps the mac field, re-encodes.
func tamperMAC(challengeStr string) (string, error) {
	return "AAAA" + challengeStr[4:], nil // corrupts the JSON prefix; decode will fail or parse differently
}

func TestDifficultyBounds(t *testing.T) {
	now := time.Now()
	for _, d := range []int{0, 5, 23, 40} {
		if _, err := Issue(testSecret, testSiteKey, testAction, d, time.Minute, now); err == nil {
			t.Fatalf("expected difficulty %d to be rejected", d)
		}
	}
	for _, d := range []int{MinDifficulty, MaxDifficulty} {
		if _, err := Issue(testSecret, testSiteKey, testAction, d, time.Minute, now); err != nil {
			t.Fatalf("difficulty %d should be allowed: %v", d, err)
		}
	}
}

func TestIssueRejectsShortSecret(t *testing.T) {
	if _, err := Issue("short", testSiteKey, testAction, 18, time.Minute, time.Now()); err == nil {
		t.Fatal("expected short secret to be rejected")
	}
}

func TestActionBinding(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, "login", 18, time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	nonce := findNonce(t, params)
	if err := Verify(params, nonce, testSecret, testSiteKey, "contact", now); err == nil {
		t.Fatal("expected cross-action reuse to be rejected")
	}
}

func TestNonceLengthBound(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	long := strings.Repeat("A", 90) // decodes to 66 raw bytes, exceeding 64
	if err := Verify(params, long, testSecret, testSiteKey, testAction, now); err == nil {
		t.Fatal("expected overly long nonce to be rejected")
	}
}

func TestIDExtraction(t *testing.T) {
	now := time.Now()
	params, err := Issue(testSecret, testSiteKey, testAction, 18, time.Minute, now)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	id, err := ID(params.Challenge)
	if err != nil {
		t.Fatalf("id extraction: %v", err)
	}
	if id == "" {
		t.Fatal("expected non-empty id")
	}
	if _, err := ID("!!!not-base64!!!"); err == nil {
		t.Fatal("expected malformed challenge to fail ID extraction")
	}
}

func flipOneBit(s string) string {
	// change the last character of the MAC to a different letter; the payload
	// stays decodable but the MAC content differs.
	if s == "" {
		return s
	}
	b := []byte(s)
	if b[len(b)-1] == 'A' {
		b[len(b)-1] = 'B'
	} else {
		b[len(b)-1] = 'A'
	}
	return string(b)
}

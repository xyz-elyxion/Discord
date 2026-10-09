package challenge

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Design:
//
//   The puzzle handed to the browser is: find a numeric nonce such that the
//   first `difficulty` bits of SHA256(salt || base64(nonce)) are zero.
//   The target `challenge` string is opaque to the client but is verifiable
//   by the server without any database state:
//
//     challenge = base64url( json{ site, action, exp, id, mac } )
//     mac       = HMAC-SHA256( secret, site "|" action "|" exp "|" base64(id) )
//
//   Because the MAC authenticates site, action and expiry, a challenge cannot
//   be re-branded for a different site, action or window, and a forged
//   challenge cannot be minted without the site secret.
//
//   The salt is random and only used by the hash; binding comes from the HMAC.

// Parameters describes a challenge to solve.
type Parameters struct {
	// Challenge is the (opaque, signed) target the client must match.
	Challenge string `json:"challenge"`
	// Salt is the random hash input.
	Salt string `json:"salt"`
	// Difficulty is the number of leading zero bits required.
	Difficulty int `json:"difficulty"`
	// MaxNumber is an upper bound for the client's search loop.
	MaxNumber int64 `json:"maxnumber"`
	// Signature is the MAC, mirrored back so the client can submit it intact.
	Signature string `json:"signature"`
}

// ErrMalformed marks challenge payloads that are not structurally valid.
var ErrMalformed = errors.New("challenge: malformed payload")

// ErrExpired marks a challenge that has passed its expiry.
var ErrExpired = errors.New("challenge: expired")

// ErrReplayed marks a challenge that was already consumed.
var ErrReplayed = errors.New("challenge: replayed")

// ErrCrossSite marks a challenge used for a different site/action than issued.
var ErrCrossSite = errors.New("challenge: cross-site reuse")

// ErrUnsolvable marks a challenge whose stated difficulty exceeds contract limits.
var ErrUnsolvable = errors.New("challenge: difficulty out of range")

// MaxDifficulty is the highest difficulty we will ever issue; protects browsers
// (and the server) from pathological CPU usage.
const MaxDifficulty = 22

// MinDifficulty is the floor; below this the PoW is trivial to bypass and is
// treated as a configuration error.
const MinDifficulty = 10

// issued is the signed payload inside a challenge string.
type issued struct {
	Site   string `json:"site"`
	Action string `json:"act,omitempty"`
	Exp    int64  `json:"exp"`
	ID     string `json:"id"`
	MAC    string `json:"mac"`
}

// Issue creates a new challenge bound to a site, action and expiry.
// secret is the site's verification secret; never send it to a client.
func Issue(secret, siteKey, action string, difficulty int, ttl time.Duration, now time.Time) (Parameters, error) {
	if len(secret) < 16 {
		return Parameters{}, errors.New("challenge: site secret too short")
	}
	if difficulty < MinDifficulty || difficulty > MaxDifficulty {
		return Parameters{}, fmt.Errorf("%w: difficulty must be between %d and %d", ErrUnsolvable, MinDifficulty, MaxDifficulty)
	}
	if ttl <= 0 {
		return Parameters{}, errors.New("challenge: ttl must be positive")
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return Parameters{}, fmt.Errorf("challenge: entropy: %w", err)
	}
	salt := make([]byte, 24)
	if _, err := rand.Read(salt); err != nil {
		return Parameters{}, fmt.Errorf("challenge: entropy: %w", err)
	}
	idEnc := base64.RawURLEncoding.EncodeToString(id)
	saltEnc := base64.RawURLEncoding.EncodeToString(salt)

	expires := now.Add(ttl).Unix()
	body := issued{
		Site:   siteKey,
		Action: action,
		Exp:    expires,
		ID:     idEnc,
	}
	body.MAC = macBytes(secret, body)
	raw, err := json.Marshal(body)
	if err != nil {
		return Parameters{}, fmt.Errorf("challenge: marshal: %w", err)
	}
	return Parameters{
		Challenge:  base64.RawURLEncoding.EncodeToString(raw),
		Salt:       saltEnc,
		Difficulty: difficulty,
		MaxNumber:  int64(1) << uint(difficulty), // upper bound; not enforced client-side
		Signature:  body.MAC,
	}, nil
}

func macBytes(secret string, body issued) string {
	input := body.Site + "|" + body.Action + "|" + fmt.Sprint(body.Exp) + "|" + body.ID
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(input))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// Verify checks a solution against a challenge.
// The caller must additionally enforce single-use (replay prevention) using the
// challenge ID via a replay cache — see verification.Store.
func Verify(params Parameters, solution string, secret, siteKey, action string, now time.Time) error {
	raw, err := base64.RawURLEncoding.DecodeString(params.Challenge)
	if err != nil {
		return fmt.Errorf("%w: cannot decode challenge", ErrMalformed)
	}
	var body issued
	if err := json.Unmarshal(raw, &body); err != nil {
		return fmt.Errorf("%w: cannot parse challenge", ErrMalformed)
	}
	if body.Site != siteKey || body.Action != action {
		return fmt.Errorf("%w: challenge bound to %q/%q not %q/%q", ErrCrossSite, body.Site, body.Action, siteKey, action)
	}
	if body.Exp <= 0 {
		return fmt.Errorf("%w: missing expiry", ErrMalformed)
	}
	if now.Unix() > body.Exp {
		return ErrExpired
	}
	// Constant-time MAC check; only here can a challenge be trusted.
	if !hmac.Equal([]byte(macBytes(secret, body)), []byte(body.MAC)) {
		return fmt.Errorf("%w: signature mismatch", ErrMalformed)
	}
	if params.Salt == "" {
		return fmt.Errorf("%w: missing salt", ErrMalformed)
	}
	if params.Difficulty < MinDifficulty || params.Difficulty > MaxDifficulty {
		return fmt.Errorf("%w: difficulty out of range", ErrUnsolvable)
	}
	nonce, err := base64.RawURLEncoding.DecodeString(solution)
	if err != nil {
		return fmt.Errorf("%w: cannot decode nonce", ErrMalformed)
	}
	if len(nonce) == 0 || len(nonce) > 64 {
		return fmt.Errorf("%w: nonce length out of range", ErrMalformed)
	}
	digest := hash(params.Salt, nonce)
	if !leadingZeroBits(digest, params.Difficulty) {
		return errors.New("challenge: solution hash does not meet difficulty")
	}
	return nil
}

// ID extracts the unique identifier from a challenge string; used for replay caches.
func ID(challengeStr string) (string, error) {
	raw, err := base64.RawURLEncoding.DecodeString(challengeStr)
	if err != nil {
		return "", fmt.Errorf("%w: cannot decode challenge", ErrMalformed)
	}
	var body issued
	if err := json.Unmarshal(raw, &body); err != nil {
		return "", fmt.Errorf("%w: cannot parse challenge", ErrMalformed)
	}
	if body.ID == "" {
		return "", fmt.Errorf("%w: missing id", ErrMalformed)
	}
	return body.ID, nil
}

// hash reproduces the client-side hashing contract: SHA256(salt || nonce).
func hash(salt string, nonce []byte) []byte {
	h := sha256.New()
	h.Write([]byte(salt))
	h.Write(nonce)
	return h.Sum(nil)
}

func leadingZeroBits(digest []byte, bits int) bool {
	if bits <= 0 {
		return true
	}
	if bits > len(digest)*8 {
		return false
	}
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

// String is for debug logs only; never print full challenges.
func (p Parameters) String() string {
	c := p.Challenge
	if len(c) > 8 {
		c = c[:8] + "…"
	}
	return fmt.Sprintf("challenge{c:%s d:%d}", c, p.Difficulty)
}

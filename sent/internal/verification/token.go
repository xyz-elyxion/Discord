// Package verification issues and validates short-lived signed verification
// tokens after a successful proof-of-work completion.
//
// Token format (base64url, dots between parts):
//
//	payload.signature
//
// payload is canonical JSON: v, sid (site key), act, host, cid (challenge id),
// exp (unix seconds), jti (unique token id). The signature is
// HMAC-SHA256(globalTokenSecret, payload).
//
// The global token secret is an operator-provided 32+ byte key (TOKEN_SECRET).
// It is deliberately separate from per-site verification secret so a site
// cannot mint tokens for another site.
package verification

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// TokenVersion lets us reject tokens minted by incompatible versions.
	TokenVersion = 1
	// MinSecretLen is the minimum TOKEN_SECRET length; below this the token
	// secret can be brute-forced.
	MinSecretLen = 32
	// MaxTokenLen bounds parsing to avoid allocating on garbage input.
	MaxTokenLen = 4096
)

// ErrMalformed, ErrExpired, ErrReplayed, ErrCrossBinding and ErrBadSignature
// are the distinct failure modes a validator can surface.
var (
	ErrMalformed    = errors.New("verification: malformed token")
	ErrExpired      = errors.New("verification: token expired")
	ErrReplayed     = errors.New("verification: token already used")
	ErrCrossBinding = errors.New("verification: token bound to different site/action/hostname")
	ErrBadSignature = errors.New("verification: bad signature")
)

// Payload is the authenticated body of a verification token.
type Payload struct {
	Version   int    `json:"v"`
	SiteKey   string `json:"sid"`
	Action    string `json:"act,omitempty"`
	Hostname  string `json:"host,omitempty"`
	Challenge string `json:"cid,omitempty"`
	ExpiresAt int64  `json:"exp"`
	TokenID   string `json:"jti"`
}

// Issuer mints tokens. It holds the global secret and a Replay cache.
type Issuer struct {
	secret []byte
	store  ReplayStore
	now    func() time.Time
}

// NewIssuer builds an Issuer. store may be nil, in which case replay
// protection is disabled and tokens are merely single-attempt re-checks.
func NewIssuer(secret string, store ReplayStore) (*Issuer, error) {
	if len(secret) < MinSecretLen {
		return nil, fmt.Errorf("verification: TOKEN_SECRET must be at least %d bytes", MinSecretLen)
	}
	return &Issuer{secret: []byte(secret), store: store, now: time.Now}, nil
}

// Issue mints a token for a completed challenge. If p.ExpiresAt is 0 it is
// set to now+ttl; if p.ExpiresAt is already set it is honored (clamped to
// now+10m so tokens can never outlive a reasonable window).
func (i *Issuer) Issue(p Payload, ttl time.Duration) (string, error) {
	if p.SiteKey == "" {
		return "", errors.New("verification: site key required")
	}
	const maxTTL = 10 * time.Minute
	if p.ExpiresAt == 0 {
		if ttl <= 0 || ttl > maxTTL {
			ttl = 2 * time.Minute
		}
		p.ExpiresAt = i.now().Add(ttl).Unix()
	} else if limit := i.now().Add(maxTTL).Unix(); p.ExpiresAt > limit {
		p.ExpiresAt = limit
	}
	tid := make([]byte, 16)
	if _, err := rand.Read(tid); err != nil {
		return "", fmt.Errorf("verification: entropy: %w", err)
	}
	p.Version = TokenVersion
	p.TokenID = base64.RawURLEncoding.EncodeToString(tid)

	raw, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("verification: marshal: %w", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	return payload + "." + base64.RawURLEncoding.EncodeToString(i.auth(payload)), nil
}

func (i *Issuer) auth(payload string) []byte {
	h := hmac.New(sha256.New, i.secret)
	h.Write([]byte(payload))
	return h.Sum(nil)
}

// Verifier validates tokens. Zero-value is not usable; use Issuer for issuance
// and validation in the same process, or share the secret across services
// (e.g. a reverse proxy integration validating tokens minted by the central
// service).
type Verifier struct {
	secret []byte
	store  ReplayStore
	now    func() time.Time
}

// auth is shared: Issuer and Verifier use the same MAC scheme.
func (v *Verifier) auth(payload string) []byte {
	h := hmac.New(sha256.New, v.secret)
	h.Write([]byte(payload))
	return h.Sum(nil)
}

// NewVerifier builds a standalone validator (for integrations that only verify).
func NewVerifier(secret string, store ReplayStore) (*Verifier, error) {
	if len(secret) < MinSecretLen {
		return nil, fmt.Errorf("verification: TOKEN_SECRET must be at least %d bytes", MinSecretLen)
	}
	return &Verifier{secret: []byte(secret), store: store, now: time.Now}, nil
}

// Validation is a successful validation result.
type Validation struct {
	Payload  Payload
	Hostname string
	Action   string
}

// Validate checks a token:
//   - signature is authentic and constant-time compared
//   - version is current
//   - not expired
//   - bound to the expected site key, and (when given) action/hostname
//   - single-use when a replay store is configured
//
// expectedSiteKey must match; expectedHost and expectedAction may be empty to
// accept any (use sparingly, prefer checking well-known hostnames).
func (v *Verifier) Validate(token, expectedSiteKey, expectedHost, expectedAction string) (*Validation, error) {
	if len(token) == 0 {
		return nil, ErrMalformed
	}
	if len(token) > MaxTokenLen {
		return nil, ErrMalformed
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, ErrMalformed
	}
	payload, sig := parts[0], parts[1]
	if !hmac.Equal(v.auth(payload), decodeSig(sig)) {
		return nil, ErrBadSignature
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot decode payload", ErrMalformed)
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("%w: cannot parse payload", ErrMalformed)
	}
	if p.Version != TokenVersion {
		return nil, fmt.Errorf("%w: unsupported version %d", ErrMalformed, p.Version)
	}
	if p.ExpiresAt <= 0 {
		return nil, fmt.Errorf("%w: missing expiry", ErrMalformed)
	}
	if v.now().Unix() > p.ExpiresAt {
		return nil, ErrExpired
	}
	if p.SiteKey != expectedSiteKey {
		return nil, fmt.Errorf("%w: token is for site %q not %q", ErrCrossBinding, p.SiteKey, expectedSiteKey)
	}
	if expectedAction != "" && p.Action != "" && p.Action != expectedAction {
		return nil, fmt.Errorf("%w: token is for action %q not %q", ErrCrossBinding, p.Action, expectedAction)
	}
	if expectedHost != "" && p.Hostname != "" && p.Hostname != expectedHost {
		return nil, fmt.Errorf("%w: token is for host %q not %q", ErrCrossBinding, p.Hostname, expectedHost)
	}
	if v.store != nil {
		if err := v.store.Consume(p.TokenID, time.Duration(p.ExpiresAt-v.now().Unix())*time.Second); err != nil {
			return nil, err
		}
	}
	return &Validation{Payload: p, Hostname: p.Hostname, Action: p.Action}, nil
}

func decodeSig(sig string) []byte {
	b, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil {
		return nil
	}
	return b
}

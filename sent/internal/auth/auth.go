// Package auth implements administrator authentication and authorization.
//
// Passwords: argon2id (64MB memory, 3 iterations — practical on small VPS).
// Sessions: random 32-byte bearer in an HttpOnly, SameSite=Lax cookie; the DB
// stores only SHA-256(token). CSRF: per-session token compare on every
// state-changing admin request. Login attempts are rate-limited per username
// AND per client id. No default credentials exist; the first admin is
// created via CLI (cmd/migrate -bootstrap).
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
)

// Role names in enforcement order.
const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleViewer   = "viewer"
)

// RoleAtLeast implements RBAC ordering: admin > operator > viewer.
func RoleAtLeast(role, required string) bool {
	rank := map[string]int{RoleViewer: 1, RoleOperator: 2, RoleAdmin: 3}
	return rank[role] >= rank[required]
}

// HashPassword derives an argon2id hash in PHC format.
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	const (
		timeCost    = 3
		memoryKiB   = 64 * 1024
		parallelism = 2
		keyLen      = 32
	)
	key := argon2.IDKey([]byte(password), salt, timeCost, memoryKiB, parallelism, keyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		memoryKiB, timeCost, parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// VerifyPassword checks a password against a PHC argon2id hash.
func VerifyPassword(password, phc string) (bool, error) {
	parts := strings.Split(phc, "$")
	// format: "" argon2id v=19 m=.. t=.. p=.. salt hash → split gives 6 parts
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errors.New("auth: unsupported hash format")
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false, fmt.Errorf("auth: parse params: %w", err)
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("auth: decode salt: %w", err)
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false, fmt.Errorf("auth: decode hash: %w", err)
	}
	got := argon2.IDKey([]byte(password), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// NewToken returns a cryptographically random session token.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// HashToken is how tokens are stored/looked up (never the raw token).
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SessionCookieName is the admin session cookie.
const SessionCookieName = "sentinel_admin_session"

// SetSessionCookie writes the auth cookie.
func SetSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		Expires:  expires,
	})
}

// ClearSessionCookie expires the auth cookie.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// ConstantTimeEqual is a small wrapper for clarity in callers.
func ConstantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

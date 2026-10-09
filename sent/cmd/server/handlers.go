package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"limey.example/sentinel/internal/auth"
	"limey.example/sentinel/internal/challenge"
	"limey.example/sentinel/internal/selfscope"
	"limey.example/sentinel/internal/verification"
)

// --- public -----------------------------------------------------------------

// challengeRequest is POST /v1/challenge.
type challengeRequest struct {
	SiteKey string `json:"siteKey"`
	Action  string `json:"action"`
}

func (s *server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		apiError(w, http.StatusMethodNotAllowed, "method", "POST required")
		return
	}
	var req challengeRequest
	if err := readJSON(w, r, &req, 4<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	// self-only scope: challenges exist only for Sentinel's own surfaces
	if req.SiteKey != selfscope.SiteKey {
		apiError(w, http.StatusNotFound, "site", "unknown or disabled site key")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	si, ok, err := s.store.GetSite(ctx, selfscope.SiteKey)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "temporary failure")
		return
	}
	if !ok || !si.Enabled {
		apiError(w, http.StatusServiceUnavailable, "site", "self site not initialized")
		return
	}
	// bound difficulty by per-site policy default when available
	diff := challenge.MinDifficulty + 8 // default 18
	ch, err := challenge.Issue(si.Secret, si.SiteKey, req.Action, diff, 2*time.Minute, time.Now())
	if err != nil {
		apiError(w, http.StatusInternalServerError, "challenge", "challenge issuance failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":  ch.Challenge,
		"salt":       ch.Salt,
		"difficulty": ch.Difficulty,
		"maxnumber":  ch.MaxNumber,
		"signature":  ch.Signature,
		"siteKey":    si.SiteKey,
		"action":     req.Action,
		"expiresIn":  120,
	})
}

// verifyRequest is POST /v1/verify.
type verifyRequest struct {
	SiteKey    string `json:"siteKey"`
	Action     string `json:"action"`
	Challenge  string `json:"challenge"`
	Salt       string `json:"salt"`
	Difficulty *int   `json:"difficulty"`
	Signature  string `json:"signature"`
	Nonce      string `json:"nonce"`
	Hostname   string `json:"hostname"`
}

func (s *server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := readJSON(w, r, &req, 16<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if req.SiteKey == "" || req.Challenge == "" || req.Nonce == "" {
		apiError(w, http.StatusBadRequest, "missing_fields", "siteKey, challenge and nonce required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	// self-only scope: verification is only meaningful for Sentinel's own site
	if req.SiteKey != selfscope.SiteKey {
		apiError(w, http.StatusNotFound, "site", "unknown or disabled site key")
		return
	}
	si, ok, err := s.store.GetSite(ctx, selfscope.SiteKey)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "temporary failure")
		return
	}
	if !ok || !si.Enabled {
		apiError(w, http.StatusServiceUnavailable, "site", "self site not initialized")
		return
	}
	// reconstruct the parameters the client received; difficulty comes from the
	// client but must match what we issued — forged difficulties fail the MAC
	// check inside challenge.Issue's blob anyway.
	diff := challenge.MinDifficulty + 8
	if req.Difficulty != nil && *req.Difficulty > challenge.MinDifficulty && *req.Difficulty <= challenge.MaxDifficulty {
		diff = *req.Difficulty
	}
	params := challenge.Parameters{
		Challenge:  req.Challenge,
		Salt:       req.Salt,
		Difficulty: diff,
		Signature:  req.Signature,
	}
	nonce := req.Nonce
	if err := challenge.Verify(params, nonce, si.Secret, si.SiteKey, req.Action, time.Now()); err != nil {
		// distinct error surfaces keep the flow debuggable without helping bots
		code := "verification_failed"
		if err == challenge.ErrExpired {
			code = "challenge_expired"
		}
		apiError(w, http.StatusBadRequest, code, "challenge rejected")
		return
	}
	cid, err := challenge.ID(req.Challenge)
	if err == nil {
		// single-use enforcement of challenges themselves
		if err := s.challengeOnce(cid, 2*time.Minute); err != nil {
			apiError(w, http.StatusBadRequest, "challenge_replay", "challenge already consumed")
			return
		}
	}
	tok, err := s.issuer.Issue(verification.Payload{
		SiteKey:   selfscope.SiteKey,
		Action:    req.Action,
		Hostname:  req.Hostname,
		Challenge: cid,
	}, s.tokenTTL())
	if err != nil {
		apiError(w, http.StatusInternalServerError, "token", "token issuance failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"verified":  true,
		"token":     tok,
		"expiresIn": int(s.tokenTTL().Seconds()),
	})
}

// challengeOnce guards against solution replay at the challenge layer.
// Users hit this via Redis in clusters; single-instance falls back to memory.
func (s *server) challengeOnce(id string, ttl time.Duration) error {
	s.challengeSeenMu.Lock()
	defer s.challengeSeenMu.Unlock()
	if s.challengeSeen == nil {
		s.challengeSeen = map[string]time.Time{}
	}
	if t, ok := s.challengeSeen[id]; ok && time.Now().Before(t) {
		return verification.ErrReplayed
	}
	if len(s.challengeSeen) > 100_000 {
		s.challengeSeen = map[string]time.Time{}
	}
	s.challengeSeen[id] = time.Now().Add(ttl)
	return nil
}

// tokenValidateRequest is POST /v1/token/validate: direct REST integration.
type tokenValidateRequest struct {
	SiteKey  string `json:"siteKey"`
	Token    string `json:"token"`
	Hostname string `json:"hostname"`
	Action   string `json:"action"`
}

func (s *server) handleTokenValidate(w http.ResponseWriter, r *http.Request) {
	var req tokenValidateRequest
	if err := readJSON(w, r, &req, 8<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	// self-only scope: token validation only recognizes Sentinel's own site
	if req.SiteKey != "" && req.SiteKey != selfscope.SiteKey {
		apiError(w, http.StatusBadRequest, "token_binding", "token not valid for this sentinel")
		return
	}
	ver := s.verifier
	val, err := ver.Validate(req.Token, selfscope.SiteKey, req.Hostname, req.Action)
	if err != nil {
		code := "token_invalid"
		switch err {
		case verification.ErrExpired:
			code = "token_expired"
		case verification.ErrReplayed:
			code = "token_replayed"
		case verification.ErrCrossBinding:
			code = "token_binding"
		case verification.ErrBadSignature:
			code = "token_signature"
		}
		apiError(w, http.StatusBadRequest, code, "token rejected")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"verified":  true,
		"siteKey":   val.Payload.SiteKey,
		"action":    val.Payload.Action,
		"hostname":  val.Payload.Hostname,
		"expiresAt": val.Payload.ExpiresAt,
	})
}

func verifierSecret() string { return getenv("SENTINEL_TOKEN_SECRET", "") }

// --- auth -------------------------------------------------------------------

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := readJSON(w, r, &req, 4<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	// rate limit per username
	if !s.loginAllowed("u:" + req.Username) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "too many login attempts")
		return
	}
	u, ok, _ := s.store.GetAdminUser(ctx, strings.TrimSpace(req.Username))
	if !ok || u.Disabled {
		// constant work factor: hash anyway to avoid user enumeration timing
		_, _ = auth.VerifyPassword(req.Password, hashForDummy())
		apiError(w, http.StatusUnauthorized, "unauthorized", "invalid credentials")
		return
	}
	valid, err := auth.VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !valid {
		apiError(w, http.StatusUnauthorized, "unauthorized", "invalid credentials")
		return
	}
	tok, err := auth.NewToken()
	if err != nil {
		apiError(w, http.StatusInternalServerError, "session", "session creation failed")
		return
	}
	csrf, err := auth.NewToken()
	if err != nil {
		apiError(w, http.StatusInternalServerError, "session", "session creation failed")
		return
	}
	expires := time.Now().Add(24 * time.Hour)
	if err := s.store.UpsertSession(ctx, storageSession(u.ID, auth.HashToken(tok), csrf, expires)); err != nil {
		apiError(w, http.StatusBadGateway, "storage", "session persistence failed")
		return
	}
	auth.SetSessionCookie(w, tok, expires)
	_ = s.store.Audit(ctx, u.Username, "auth.login", u.Username, nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"username": u.Username,
		"role":     u.Role,
		"csrf":     csrf,
	})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(auth.SessionCookieName)
	if err == nil {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		_ = s.store.DeleteSession(ctx, auth.HashToken(c.Value))
	}
	auth.ClearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	s.writeAuthUser(w, r)
}

func (s *server) writeAuthUser(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	c, _ := r.Cookie(auth.SessionCookieName)
	if c == nil {
		apiError(w, http.StatusUnauthorized, "unauthorized", "no session")
		return
	}
	sess, ok, _ := s.store.GetSession(ctx, auth.HashToken(c.Value))
	if !ok {
		apiError(w, http.StatusUnauthorized, "unauthorized", "no session")
		return
	}
	u, ok, _ := s.store.GetUserByID(ctx, sess.UserID)
	if !ok {
		apiError(w, http.StatusUnauthorized, "unauthorized", "no account")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"username": u.Username, "role": u.Role, "csrf": sess.CSRF})
}

func hashForDummy() string {
	return "$argon2id$v=19$m=65536,t=3,p=2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}

func randID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var _ = json.Marshal

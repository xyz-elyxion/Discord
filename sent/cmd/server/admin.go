package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"limey.example/sentinel/internal/auth"
	"limey.example/sentinel/internal/storage"
)

// --- sites -------------------------------------------------------------------

type siteDTO struct {
	SiteKey   string   `json:"siteKey"`
	Name      string   `json:"name"`
	Hostnames []string `json:"hostnames"`
	Enabled   bool     `json:"enabled"`
	CreatedAt string   `json:"createdAt"`
}

func toSiteDTO(s storage.Site) siteDTO {
	return siteDTO{
		SiteKey: s.SiteKey, Name: s.Name, Hostnames: s.Hostnames,
		Enabled: s.Enabled, CreatedAt: s.CreatedAt.Format(time.RFC3339),
	}
}

func (s *server) handleListSites(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	sites, err := s.store.ListSites(ctx)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "cannot list sites")
		return
	}
	out := make([]siteDTO, 0, len(sites))
	for _, si := range sites {
		out = append(out, toSiteDTO(si))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sites": out})
}

type createSiteRequest struct {
	SiteKey   string   `json:"siteKey"`
	Name      string   `json:"name"`
	Hostnames []string `json:"hostnames"`
}

func (s *server) handleCreateSite(w http.ResponseWriter, r *http.Request) {
	var req createSiteRequest
	if err := readJSON(w, r, &req, 8<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	req.SiteKey = strings.TrimSpace(req.SiteKey)
	if len(req.SiteKey) < 3 || len(req.SiteKey) > 64 {
		apiError(w, http.StatusBadRequest, "validation", "siteKey length must be 3..64")
		return
	}
	if len(req.Hostnames) == 0 {
		apiError(w, http.StatusBadRequest, "validation", "at least one hostname required")
		return
	}
	// generate the per-site secret server-side; shown once
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	si, err := s.store.CreateSite(ctx, storage.Site{
		SiteKey:   req.SiteKey,
		Name:      req.Name,
		Secret:    hex.EncodeToString(secret),
		Hostnames: req.Hostnames,
		Enabled:   true,
	})
	if err != nil {
		apiError(w, http.StatusConflict, "site_exists", "siteKey already registered")
		return
	}
	actor(r, s.store, "site.create", req.SiteKey)
	// Also create a default policy for the site.
	_, _ = s.store.UpsertPolicy(ctx, defaultPolicyFor(req.SiteKey))
	writeJSON(w, http.StatusCreated, map[string]any{
		"site":   toSiteDTO(si),
		"secret": si.Secret, // shown exactly once; rotation available later
	})
}

func defaultPolicyFor(siteKey string) storage.Policy {
	return storage.Policy{
		SiteKey: siteKey, Name: "default", ActionName: "default",
		RequireVerified: false, ChallengeDifficulty: 18,
		ThresholdChallenge: 20, ThresholdThrottle: 50, ThresholdBlock: 80,
		RateLimit: 60, RateWindowSeconds: 60,
		FailureMode: "fail_closed", Simulation: false,
		Allowlist: []byte("[]"), Denylist: []byte("[]"),
	}
}

func (s *server) handleDeleteSite(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	if err := s.store.DeleteSite(ctx, key); err != nil {
		apiError(w, http.StatusBadGateway, "storage", "delete failed")
		return
	}
	actor(r, s.store, "site.delete", key)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleRotate(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	if err := s.store.RotateSiteSecret(ctx, key, hex.EncodeToString(secret)); err != nil {
		apiError(w, http.StatusBadGateway, "storage", "rotation failed")
		return
	}
	actor(r, s.store, "site.rotate", key)
	writeJSON(w, http.StatusOK, map[string]any{"secret": hex.EncodeToString(secret)})
}

// --- policies ----------------------------------------------------------------

func (s *server) handleListPolicies(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	siteKey := r.URL.Query().Get("siteKey")
	pols, err := s.store.ListPolicies(ctx, siteKey)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "cannot list policies")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"policies": pols})
}

func (s *server) handleUpsertPolicy(w http.ResponseWriter, r *http.Request) {
	var in storage.Policy
	if err := readJSON(w, r, &in, 16<<10); err != nil {
		apiError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if in.SiteKey == "" {
		apiError(w, http.StatusBadRequest, "validation", "siteKey required")
		return
	}
	if in.ChallengeDifficulty == 0 {
		in.ChallengeDifficulty = 18
	}
	if !in.RequireVerified && in.ThresholdChallenge == 0 {
		in.ThresholdChallenge = 20
		in.ThresholdThrottle = 50
		in.ThresholdBlock = 80
	}
	if in.FailureMode == "" {
		in.FailureMode = "fail_closed"
	}
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	out, err := s.store.UpsertPolicy(ctx, in)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "policy save failed")
		return
	}
	actor(r, s.store, "policy.upsert", in.SiteKey+"/"+in.Name)
	writeJSON(w, http.StatusOK, out)
}

// --- events / analytics / audit ----------------------------------------------

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	q, err := parseEventQuery(r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	rows, err := s.store.QueryEvents(ctx, q)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "event query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": rows, "count": len(rows)})
}

func parseEventQuery(r *http.Request) (storage.EventQuery, error) {
	q := storage.EventQuery{
		SiteKey:  r.URL.Query().Get("siteKey"),
		Decision: r.URL.Query().Get("decision"),
		Action:   r.URL.Query().Get("action"),
		Rule:     r.URL.Query().Get("rule"),
	}
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			return q, errBadQuery("limit must be 1..1000")
		}
		q.Limit = n
	}
	if v := r.URL.Query().Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return q, errBadQuery("offset invalid")
		}
		q.Offset = n
	}
	return q, nil
}

type badQuery string

func (b badQuery) Error() string { return string(b) }
func errBadQuery(s string) error { return badQuery(s) }

func (s *server) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	siteKey := r.URL.Query().Get("siteKey")
	hours := 24
	if v := r.URL.Query().Get("hours"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 720 {
			apiError(w, http.StatusBadRequest, "validation", "hours must be 1..720")
			return
		}
		hours = n
	}
	agg, err := s.store.Analytics(ctx, siteKey, hours)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "analytics failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"buckets": agg, "hours": hours})
}

func (s *server) handleAudit(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r)
	defer cancel()
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	rows, err := s.store.QueryAudit(ctx, limit)
	if err != nil {
		apiError(w, http.StatusBadGateway, "storage", "audit query failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": rows})
}

// --- health -------------------------------------------------------------------

func (s *server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleReady(w http.ResponseWriter, r *http.Request) {
	if s.store.Healthy(r.Context()) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready", "postgres": "up"})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "degraded", "postgres": "down"})
}

// --- shared helpers ------------------------------------------------------------

func contextWithTimeout(r *http.Request) (contextCtx, cancelFunc) {
	return contextWithDeadline(r, 5*time.Second)
}

// --- login rate limiting ---------------------------------------------------------

var loginLimiter struct {
	mu      sync.Mutex
	attempt map[string][]time.Time
}

func (s *server) loginAllowed(key string) bool {
	loginLimiter.mu.Lock()
	defer loginLimiter.mu.Unlock()
	if loginLimiter.attempt == nil {
		loginLimiter.attempt = map[string][]time.Time{}
	}
	now := time.Now()
	window := now.Add(-10 * time.Minute)
	recent := []time.Time{}
	for _, t := range loginLimiter.attempt[key] {
		if t.After(window) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= 10 {
		return false
	}
	recent = append(recent, now)
	loginLimiter.attempt[key] = recent
	return true
}

// --- session / audit glue -----------------------------------------------------------

func actor(r *http.Request, st *storeT, action, target string) {
	c, err := r.Cookie(auth.SessionCookieName)
	if err != nil {
		return
	}
	ctx, cancel := contextWithDeadline(r, 3*time.Second)
	defer cancel()
	sess, ok, _ := st.GetSession(ctx, auth.HashToken(c.Value))
	if !ok {
		return
	}
	u, ok, _ := st.GetUserByID(ctx, sess.UserID)
	if !ok {
		return
	}
	_ = st.Audit(ctx, u.Username, action, target, nil)
}

func storageSession(userID int64, hash, csrf string, expires time.Time) storage.AdminSession {
	return storage.AdminSession{TokenHash: hash, UserID: userID, CSRF: csrf, ExpiresAt: expires}
}

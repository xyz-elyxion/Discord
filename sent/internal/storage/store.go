// Package storage persists configuration and events to PostgreSQL.
//
// Degraded mode: the middleware never talks to the DB directly; the server
// wires it through a registry that keeps the last-known site configs cached
// in memory for a short window (see Registry), and the event sink buffers to
// a bounded channel, dropping oldest entries instead of blocking request
// handling when the DB is slow or unavailable. Behavior is explicit and
// observable: the drop is logged and reported in metrics.
package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Site mirrors the sites table row.
type Site struct {
	SiteKey   string    `json:"siteKey"`
	Name      string    `json:"name"`
	Secret    string    `json:"-"` // never serialized
	Hostnames []string  `json:"hostnames"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Policy mirrors a route_policies row.
type Policy struct {
	SiteKey             string          `json:"siteKey"`
	Name                string          `json:"name"`
	Hostname            string          `json:"hostname"`
	Method              string          `json:"method"`
	PathPrefix          string          `json:"pathPrefix"`
	ActionName          string          `json:"actionName"`
	RequireVerified     bool            `json:"requireVerified"`
	ChallengeDifficulty int             `json:"challengeDifficulty"`
	ThresholdChallenge  float64         `json:"thresholdChallenge"`
	ThresholdThrottle   float64         `json:"thresholdThrottle"`
	ThresholdBlock      float64         `json:"thresholdBlock"`
	RateLimit           int             `json:"rateLimit"`
	RateWindowSeconds   int             `json:"rateWindowSeconds"`
	FailureMode         string          `json:"failureMode"`
	Simulation          bool            `json:"simulation"`
	Allowlist           json.RawMessage `json:"allowlist"`
	Denylist            json.RawMessage `json:"denylist"`
}

// EventRow is an events row.
type EventRow struct {
	TS        time.Time `json:"ts"`
	SiteKey   string    `json:"siteKey"`
	Hostname  string    `json:"hostname"`
	Action    string    `json:"action"`
	ClientID  string    `json:"clientId"`
	Decision  string    `json:"decision"`
	Score     float64   `json:"score"`
	Degraded  bool      `json:"degraded"`
	Simulated bool      `json:"simulated"`
	Method    string    `json:"method"`
	Path      string    `json:"path"`
	Reason    string    `json:"reason"`
	Rules     []string  `json:"rules"`
}

// Store wraps a pgxpool.
type Store struct {
	pool *pgxpool.Pool
}

// Open validates connectivity eagerly; callers handle ErrUnreachable.
var ErrUnreachable = errors.New("storage: database unreachable")

func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("%w: parse dsn: %v", ErrUnreachable, err)
	}
	cfg.MaxConns = 20
	cfg.MinConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	probe, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(probe); err != nil {
		pool.Close()
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Healthy probes the DB.
func (s *Store) Healthy(ctx context.Context) bool {
	probe, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return s.pool.Ping(probe) == nil
}

// --- sites -----------------------------------------------------------------

const siteCols = `site_key, name, secret, hostnames, enabled`

func scanSite(row interface{ Scan(dest ...any) error }) (Site, error) {
	var si Site
	err := row.Scan(&si.SiteKey, &si.Name, &si.Secret, &si.Hostnames, &si.Enabled)
	return si, err
}

// CreateSite inserts a new site.
func (s *Store) CreateSite(ctx context.Context, si Site) (Site, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO sites (site_key, name, secret, hostnames, enabled)
		 VALUES ($1,$2,$3,$4,$5) RETURNING `+siteCols,
		si.SiteKey, si.Name, si.Secret, si.Hostnames, si.Enabled)
	out, err := scanSite(row)
	if err != nil {
		return Site{}, fmt.Errorf("storage: create site: %w", err)
	}
	return out, nil
}

// GetSite returns one site by key.
func (s *Store) GetSite(ctx context.Context, siteKey string) (Site, bool, error) {
	row := s.pool.QueryRow(ctx, `SELECT `+siteCols+` FROM sites WHERE site_key = $1`, siteKey)
	si, err := scanSite(row)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return Site{}, false, err
		}
		return Site{}, false, nil // not found (pgx returns ErrNoRows which we fold for API simplicity)
	}
	return si, true, nil
}

// ListSites returns all sites.
func (s *Store) ListSites(ctx context.Context) ([]Site, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+siteCols+` FROM sites ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("storage: list sites: %w", err)
	}
	defer rows.Close()
	var out []Site
	for rows.Next() {
		si, err := scanSite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, si)
	}
	return out, rows.Err()
}

// UpdateSite mutates the editable fields.
func (s *Store) UpdateSite(ctx context.Context, si Site) (Site, error) {
	row := s.pool.QueryRow(ctx,
		`UPDATE sites SET name=$2, hostnames=$3, enabled=$4, updated_at=now()
		 WHERE site_key=$1 RETURNING `+siteCols,
		si.SiteKey, si.Name, si.Hostnames, si.Enabled)
	out, err := scanSite(row)
	if err != nil {
		return Site{}, fmt.Errorf("storage: update site: %w", err)
	}
	return out, nil
}

// RotateSiteSecret replaces the per-site signing secret.
func (s *Store) RotateSiteSecret(ctx context.Context, siteKey, newSecret string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE sites SET secret=$2, updated_at=now() WHERE site_key=$1`, siteKey, newSecret)
	return err
}

// DeleteSite removes the site and cascading policies.
func (s *Store) DeleteSite(ctx context.Context, siteKey string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sites WHERE site_key=$1`, siteKey)
	return err
}

// --- events -----------------------------------------------------------------

// ListPolicies collects all policies for a site (or all sites when "").
func (s *Store) ListPolicies(ctx context.Context, siteKey string) ([]Policy, error) {
	sql := `SELECT site_key, name, COALESCE(hostname,''), COALESCE(method,''), COALESCE(path_prefix,''), COALESCE(action_name,'default'),
	        require_verified, challenge_difficulty, threshold_challenge, threshold_throttle, threshold_block,
	        rate_limit, rate_window_seconds, failure_mode, simulation, allowlist, denylist
	        FROM route_policies`
	args := []any{}
	if siteKey != "" {
		sql += ` WHERE site_key = $1`
		args = append(args, siteKey)
	}
	sql += ` ORDER BY created_at`
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: list policies: %w", err)
	}
	defer rows.Close()
	var out []Policy
	for rows.Next() {
		var p Policy
		if err := rows.Scan(&p.SiteKey, &p.Name, &p.Hostname, &p.Method, &p.PathPrefix, &p.ActionName,
			&p.RequireVerified, &p.ChallengeDifficulty, &p.ThresholdChallenge, &p.ThresholdThrottle, &p.ThresholdBlock,
			&p.RateLimit, &p.RateWindowSeconds, &p.FailureMode, &p.Simulation, &p.Allowlist, &p.Denylist); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpsertPolicy inserts or updates a policy keyed by (site_key, name).
func (s *Store) UpsertPolicy(ctx context.Context, p Policy) (Policy, error) {
	row := s.pool.QueryRow(ctx, `INSERT INTO route_policies
		(site_key, name, hostname, method, path_prefix, action_name, require_verified, challenge_difficulty,
		 threshold_challenge, threshold_throttle, threshold_block, rate_limit, rate_window_seconds,
		 failure_mode, simulation, allowlist, denylist, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
		ON CONFLICT (site_key, name) DO UPDATE SET
		  hostname=EXCLUDED.hostname, method=EXCLUDED.method, path_prefix=EXCLUDED.path_prefix,
		  action_name=EXCLUDED.action_name, require_verified=EXCLUDED.require_verified,
		  challenge_difficulty=EXCLUDED.challenge_difficulty, threshold_challenge=EXCLUDED.threshold_challenge,
		  threshold_throttle=EXCLUDED.threshold_throttle, threshold_block=EXCLUDED.threshold_block,
		  rate_limit=EXCLUDED.rate_limit, rate_window_seconds=EXCLUDED.rate_window_seconds,
		  failure_mode=EXCLUDED.failure_mode, simulation=EXCLUDED.simulation,
		  allowlist=EXCLUDED.allowlist, denylist=EXCLUDED.denylist, updated_at=now()
		RETURNING site_key, name, COALESCE(hostname,''), COALESCE(method,''), COALESCE(path_prefix,''), COALESCE(action_name,'default'),
		  require_verified, challenge_difficulty, threshold_challenge, threshold_throttle, threshold_block,
		  rate_limit, rate_window_seconds, failure_mode, simulation, allowlist, denylist`,
		p.SiteKey, p.Name, p.Hostname, p.Method, p.PathPrefix, p.ActionName, p.RequireVerified,
		p.ChallengeDifficulty, p.ThresholdChallenge, p.ThresholdThrottle, p.ThresholdBlock,
		p.RateLimit, p.RateWindowSeconds, p.FailureMode, p.Simulation, p.Allowlist, p.Denylist)
	var out Policy
	if err := row.Scan(&out.SiteKey, &out.Name, &out.Hostname, &out.Method, &out.PathPrefix, &out.ActionName,
		&out.RequireVerified, &out.ChallengeDifficulty, &out.ThresholdChallenge, &out.ThresholdThrottle, &out.ThresholdBlock,
		&out.RateLimit, &out.RateWindowSeconds, &out.FailureMode, &out.Simulation, &out.Allowlist, &out.Denylist); err != nil {
		return Policy{}, fmt.Errorf("storage: upsert policy: %w", err)
	}
	return out, nil
}

// InsertEvent persists one event. Never blocks the caller beyond context.
func (s *Store) InsertEvent(ctx context.Context, e EventRow) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO events (ts, site_key, hostname, action, client_id, decision, score, degraded, simulated, method, path, reason, rules)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		e.TS, e.SiteKey, e.Hostname, e.Action, e.ClientID, e.Decision, e.Score,
		e.Degraded, e.Simulated, e.Method, e.Path, e.Reason, e.Rules)
	return err
}

// EventQuery filters for the explorer + analytics.
type EventQuery struct {
	SiteKey   string
	Decision  string
	Action    string
	Rule      string
	TimeFrom  *time.Time
	TimeUntil *time.Time
	Limit     int
	Offset    int
}

// QueryEvents fetches events matching the filter.
func (s *Store) QueryEvents(ctx context.Context, q EventQuery) ([]EventRow, error) {
	if q.Limit <= 0 || q.Limit > 1000 {
		q.Limit = 100
	}
	sql := `SELECT ts, site_key, hostname, action, client_id, decision, score, degraded, simulated, method, path, reason, rules
	        FROM events WHERE 1=1`
	args := []any{}
	n := 1
	add := func(cond string, v any) {
		sql += fmt.Sprintf(" AND %s = $%d", cond, n)
		args = append(args, v)
		n++
	}
	if q.SiteKey != "" {
		add("site_key", q.SiteKey)
	}
	if q.Decision != "" {
		add("decision", q.Decision)
	}
	if q.Action != "" {
		add("action", q.Action)
	}
	if q.Rule != "" {
		sql += fmt.Sprintf(" AND $%d = ANY(rules)", n)
		args = append(args, q.Rule)
		n++
	}
	sql += fmt.Sprintf(" ORDER BY ts DESC LIMIT %d OFFSET %d", q.Limit, q.Offset)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("storage: query events: %w", err)
	}
	defer rows.Close()
	var out []EventRow
	for rows.Next() {
		var e EventRow
		if err := rows.Scan(&e.TS, &e.SiteKey, &e.Hostname, &e.Action, &e.ClientID, &e.Decision,
			&e.Score, &e.Degraded, &e.Simulated, &e.Method, &e.Path, &e.Reason, &e.Rules); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteOldEvents prunes retention window; returns rows removed.
func (s *Store) DeleteOldEvents(ctx context.Context, olderThan time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM events WHERE ts < now() - $1::interval`, olderThan)
	if err != nil {
		return 0, fmt.Errorf("storage: prune events: %w", err)
	}
	return tag.RowsAffected(), nil
}

// AnalyticsAgg is a per-bucket analytics row.
type AnalyticsAgg struct {
	Bucket     time.Time          `json:"bucket"`
	Decisions  map[string]float64 `json:"decisions"`
	Challenges int64              `json:"challenges"`
	BotEvents  int64              `json:"botEvents"`
}

// Analytics returns hourly aggregate counts for dashboards, computed by SQL
// (real data — never synthesized).
func (s *Store) Analytics(ctx context.Context, siteKey string, windowHours int) ([]AnalyticsAgg, error) {
	if windowHours <= 0 || windowHours > 720 {
		windowHours = 24
	}
	sql := `SELECT date_trunc('hour', ts) AS bucket, decision, count(*) AS n
	        FROM events
	        WHERE ts > now() - ($1::text || ' hours')::interval`
	args := []any{}
	if siteKey != "" {
		sql += ` AND site_key = $2`
		args = append(args, windowHours, siteKey)
	} else {
		args = append(args, windowHours)
	}
	sql += ` GROUP BY 1, 2 ORDER BY 1`
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	agg := map[time.Time]*AnalyticsAgg{}
	for rows.Next() {
		var bucket time.Time
		var decision string
		var n int64
		if err := rows.Scan(&bucket, &decision, &n); err != nil {
			return nil, err
		}
		a, ok := agg[bucket]
		if !ok {
			a = &AnalyticsAgg{Bucket: bucket, Decisions: map[string]float64{}}
			agg[bucket] = a
		}
		a.Decisions[decision] = float64(n)
		if decision == "challenge" {
			a.Challenges += n
		}
		if decision == "block" {
			a.BotEvents += n
		}
	}
	out := make([]AnalyticsAgg, 0, len(agg))
	for _, a := range agg {
		out = append(out, *a)
	}
	return out, rows.Err()
}

package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// AuditEntry is one audit_log row.
type AuditEntry struct {
	TS     time.Time       `json:"ts"`
	Actor  string          `json:"actor"`
	Action string          `json:"action"`
	Target string          `json:"target"`
	Detail json.RawMessage `json:"detail"`
}

// Audit appends an entry. Detail may be nil.
func (s *Store) Audit(ctx context.Context, actor, action, target string, detail any) error {
	var d json.RawMessage
	if detail != nil {
		raw, err := json.Marshal(detail)
		if err != nil {
			return fmt.Errorf("storage: audit marshal: %w", err)
		}
		d = raw
	}
	_, err := s.pool.Exec(ctx,
		`INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)`,
		actor, action, target, d)
	return err
}

// QueryAudit lists recent audit entries.
func (s *Store) QueryAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx,
		`SELECT ts, actor, action, target, detail FROM audit_log ORDER BY ts DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var a AuditEntry
		if err := rows.Scan(&a.TS, &a.Actor, &a.Action, &a.Target, &a.Detail); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// AdminUser is an administrator account row.
type AdminUser struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	PasswordHash string    `json:"-"`
	Role         string    `json:"role"`
	Disabled     bool      `json:"disabled"`
	CreatedAt    time.Time `json:"createdAt"`
}

// CreateAdminUser inserts an account; caller supplies the argon2id hash.
func (s *Store) CreateAdminUser(ctx context.Context, u AdminUser) (AdminUser, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO admin_users (username, password_hash, role) VALUES ($1,$2,$3)
		 RETURNING id, username, password_hash, role, disabled, created_at`,
		u.Username, u.PasswordHash, u.Role)
	var out AdminUser
	if err := row.Scan(&out.ID, &out.Username, &out.PasswordHash, &out.Role, &out.Disabled, &out.CreatedAt); err != nil {
		return AdminUser{}, fmt.Errorf("storage: create admin: %w", err)
	}
	return out, nil
}

// GetAdminUser looks up by username.
func (s *Store) GetAdminUser(ctx context.Context, username string) (AdminUser, bool, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, username, password_hash, role, disabled, created_at FROM admin_users WHERE username=$1`, username)
	var u AdminUser
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.Disabled, &u.CreatedAt)
	if err != nil {
		return AdminUser{}, false, nil
	}
	return u, true, nil
}

// GetUserByID looks up an admin by id.
func (s *Store) GetUserByID(ctx context.Context, id int64) (AdminUser, bool, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, username, password_hash, role, disabled, created_at FROM admin_users WHERE id=$1`, id)
	var u AdminUser
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.Disabled, &u.CreatedAt)
	if err != nil {
		return AdminUser{}, false, nil
	}
	return u, true, nil
}

// AdminSession is a session row keyed by token hash.
type AdminSession struct {
	TokenHash string    `json:"tokenHash"`
	UserID    int64     `json:"userId"`
	CSRF      string    `json:"csrf"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// UpsertSession stores a session.
func (s *Store) UpsertSession(ctx context.Context, sess AdminSession) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO admin_sessions (token_hash, user_id, csrf_token, expires_at)
		 VALUES ($1,$2,$3,$4)
		 ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
		sess.TokenHash, sess.UserID, sess.CSRF, sess.ExpiresAt)
	return err
}

// GetSession returns a valid (unexpired) session or false.
func (s *Store) GetSession(ctx context.Context, tokenHash string) (AdminSession, bool, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT token_hash, user_id, csrf_token, expires_at FROM admin_sessions
		 WHERE token_hash=$1 AND expires_at > now()`, tokenHash)
	var sess AdminSession
	if err := row.Scan(&sess.TokenHash, &sess.UserID, &sess.CSRF, &sess.ExpiresAt); err != nil {
		return AdminSession{}, false, nil
	}
	// sliding expiry
	_, _ = s.pool.Exec(ctx, `UPDATE admin_sessions SET expires_at = now() + interval '24 hours' WHERE token_hash=$1`, tokenHash)
	return sess, true, nil
}

// DeleteSession logs a session out.
func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM admin_sessions WHERE token_hash=$1`, tokenHash)
	return err
}

// CleanupSessions prunes expired rows.
func (s *Store) CleanupSessions(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM admin_sessions WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// APIKey mirrors api_keys.
type APIKey struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	KeyHash string `json:"-"`
	Role    string `json:"role"`
}

// CreateAPIKey stores the (already-hashed) key; the plaintext is shown once.
func (s *Store) CreateAPIKey(ctx context.Context, k APIKey) (APIKey, error) {
	row := s.pool.QueryRow(ctx,
		`INSERT INTO api_keys (name, key_hash, role) VALUES ($1,$2,$3)
		 RETURNING id, name, key_hash, role`, k.Name, k.KeyHash, k.Role)
	var out APIKey
	if err := row.Scan(&out.ID, &out.Name, &out.KeyHash, &out.Role); err != nil {
		return APIKey{}, err
	}
	return out, nil
}

// APIKeyByHash resolves a presented key.
func (s *Store) APIKeyByHash(ctx context.Context, hash string) (APIKey, bool, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT id, name, key_hash, role FROM api_keys WHERE key_hash=$1 AND disabled=false`, hash)
	var k APIKey
	if err := row.Scan(&k.ID, &k.Name, &k.KeyHash, &k.Role); err != nil {
		return APIKey{}, false, nil
	}
	_, _ = s.pool.Exec(ctx, `UPDATE api_keys SET last_used_at=now() WHERE id=$1`, k.ID)
	return k, true, nil
}

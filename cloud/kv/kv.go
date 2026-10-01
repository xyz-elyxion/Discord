package kv

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	_ "github.com/jackc/pgx/v5/stdlib"
)

/**
 * A tiny key-value layer for the LimeyCloud backend.
 *
 * Backends:
 *   - Postgres (DATABASE_URL) — primary. One table `limey_cloud_kv`;
 *     hash-shaped entries stored as JSONB to mirror the Redis hashes.
 *   - Redis (REDIS_URI) — legacy fallback when no DATABASE_URL is set.
 *
 * Only the operations the backend actually uses are implemented:
 * Get, HGet, HMGet, HSet, Del, ScanKeys.
 */

var (
	ErrNotFound = errors.New("kv: not found")
	db          *sql.DB
	usePostgres bool
)

// Open initialises the KV layer. It prefers DATABASE_URL (Postgres) and
// falls back to REDIS_URI when no Postgres is configured. Callers must check
// Backend() to learn which one is active.
func Open(postgresURL, redisURL string) error {
	if postgresURL != "" {
		d, err := sql.Open("pgx", postgresURL)
		if err != nil {
			return fmt.Errorf("kv: open postgres: %w", err)
		}
		d.SetMaxOpenConns(5)

		if err := d.Ping(); err != nil {
			return fmt.Errorf("kv: ping postgres: %w", err)
		}

		schema := `
			CREATE TABLE IF NOT EXISTS limey_cloud_kv (
				key   TEXT PRIMARY KEY,
				value JSONB NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);`
		if _, err := d.Exec(schema); err != nil {
			return fmt.Errorf("kv: create table: %w", err)
		}

		db = d
		usePostgres = true
		return nil
	}

	if redisURL != "" {
		if err := openRedis(redisURL); err != nil {
			return err
		}
		usePostgres = false
		return nil
	}

	return errors.New("kv: no backend configured (set DATABASE_URL or REDIS_URI)")
}

// Backend reports which backend is active ("postgres" or "redis").
func Backend() string {
	if usePostgres {
		return "postgres"
	}
	return "redis"
}

// Get returns a plain string value (used for secrets).
func Get(key string) (string, error) {
	if usePostgres {
		var raw string
		err := db.QueryRow(`SELECT value::text FROM limey_cloud_kv WHERE key = $1`, key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		if err != nil {
			return "", err
		}
		// value column holds a JSON scalar string
		var s string
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			return "", err
		}
		return s, nil
	}
	return redisGet(key)
}

// HGet returns one field of a hash.
func HGet(key, field string) (string, error) {
	if usePostgres {
		var raw string
		err := db.QueryRow(`SELECT value::text FROM limey_cloud_kv WHERE key = $1`, key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		if err != nil {
			return "", err
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(raw), &obj); err != nil {
			return "", err
		}
		v, ok := decodeVal(obj[field]).(string)
		if !ok {
			return "", ErrNotFound
		}
		return v, nil
	}
	return redisHGet(key, field)
}

// HMGet returns multiple fields of a hash; missing fields come back as nil.
func HMGet(key string, fields ...string) ([]any, error) {
	if usePostgres {
		var raw string
		err := db.QueryRow(`SELECT value::text FROM limey_cloud_kv WHERE key = $1`, key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			// all fields nil, like redis
			out := make([]any, len(fields))
			for i := range out {
				out[i] = nil
			}
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(raw), &obj); err != nil {
			return nil, err
		}
		out := make([]any, len(fields))
		for i, f := range fields {
			if v, ok := obj[f]; ok {
				out[i] = decodeVal(v)
			} else {
				out[i] = nil
			}
		}
		return out, nil
	}
	return redisHMGet(key, fields...)
}

// HSet writes fields to a hash (merge semantics like redis HSET with a map).
func HSet(key string, fields map[string]any) error {
	if usePostgres {
		// read-modify-write to merge with existing hash fields
		var obj map[string]any
		var raw string
		err := db.QueryRow(`SELECT value::text FROM limey_cloud_kv WHERE key = $1`, key).Scan(&raw)
		if err == nil {
			_ = json.Unmarshal([]byte(raw), &obj)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if obj == nil {
			obj = map[string]any{}
		}
		for k, v := range fields {
			obj[k] = encodeVal(v)
		}
		blob, err := json.Marshal(obj)
		if err != nil {
			return err
		}
		_, err = db.Exec(`
			INSERT INTO limey_cloud_kv (key, value, updated_at)
			VALUES ($1, $2::jsonb, now())
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
			key, string(blob))
		return err
	}
	return redisHSet(key, fields)
}

// binaryTag wraps values that are not valid UTF-8 (e.g. the deflate-compressed
// settings blob). JSONB columns cannot hold invalid Unicode escape sequences
// (SQLSTATE 22P05), so such values are stored base64-encoded under this marker
// and transparently decoded on read.
const binaryTag = "__b64"

func encodeVal(v any) any {
	s, ok := v.(string)
	if !ok || utf8.ValidString(s) {
		return v
	}
	return map[string]any{
		binaryTag: base64.StdEncoding.EncodeToString([]byte(s)),
	}
}

func decodeVal(v any) any {
	if m, ok := v.(map[string]any); ok {
		if b64, ok := m[binaryTag].(string); ok {
			if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
				return string(raw)
			}
		}
	}
	return v
}

// Del deletes keys.
func Del(keys ...string) error {
	if usePostgres {
		for _, k := range keys {
			if _, err := db.Exec(`DELETE FROM limey_cloud_kv WHERE key = $1`, k); err != nil {
				return err
			}
		}
		return nil
	}
	return redisDel(keys...)
}

// ScanKeys returns all keys matching a pattern (only "prefix:*" is supported).
func ScanKeys(pattern string) ([]string, error) {
	prefix := strings.TrimSuffix(pattern, "*")
	if usePostgres {
		rows, err := db.Query(`SELECT key FROM limey_cloud_kv WHERE key LIKE $1`, prefix+"%")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				return nil, err
			}
			out = append(out, k)
		}
		return out, rows.Err()
	}
	return redisScanKeys(pattern)
}

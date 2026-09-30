package kv

import (
	"encoding/json"
	"errors"
)

// Set stores a plain string value (used for secrets). Mirrors redis SET.
func Set(key, value string) error {
	if usePostgres {
		blob, err := json.Marshal(value) // JSON string scalar
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
	return redisSet(key, value)
}

// ensure json import stays used if backend list changes
var _ = json.Marshal
var _ = errors.New

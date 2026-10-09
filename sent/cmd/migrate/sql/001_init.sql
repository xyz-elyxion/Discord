-- Sentinel database initialization.
-- Applied by cmd/migrate; safe to re-run.

CREATE TABLE IF NOT EXISTS sites (
    id            BIGSERIAL PRIMARY KEY,
    site_key      TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    secret        TEXT NOT NULL,             -- per-site challenge signing secret (argon2-peppered at rest? no: random 32B hex)
    hostnames     TEXT[] NOT NULL DEFAULT '{}',
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS route_policies (
-- (site_key, name) is the natural lookup key
    UNIQUE (site_key, name),
    id            BIGSERIAL PRIMARY KEY,
    site_key      TEXT NOT NULL REFERENCES sites(site_key) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    hostname      TEXT NOT NULL DEFAULT '',
    method        TEXT NOT NULL DEFAULT '',
    path_prefix   TEXT NOT NULL DEFAULT '',
    action_name   TEXT NOT NULL DEFAULT 'default',
    require_verified   BOOLEAN NOT NULL DEFAULT FALSE,
    challenge_difficulty INT NOT NULL DEFAULT 18 CHECK (challenge_difficulty BETWEEN 10 AND 22),
    threshold_challenge  REAL NOT NULL DEFAULT 20,
    threshold_throttle   REAL NOT NULL DEFAULT 50,
    threshold_block      REAL NOT NULL DEFAULT 80,
    rate_limit           INT  NOT NULL DEFAULT 0,
    rate_window_seconds  INT  NOT NULL DEFAULT 60,
    failure_mode         TEXT NOT NULL DEFAULT 'fail_closed' CHECK (failure_mode IN ('fail_open','fail_closed')),
    simulation           BOOLEAN NOT NULL DEFAULT FALSE,
    allowlist            JSONB NOT NULL DEFAULT '[]',  -- [{clientId, cidrPrefix, comment}]
    denylist             JSONB NOT NULL DEFAULT '[]',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
    id            BIGSERIAL PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    site_key      TEXT NOT NULL,
    hostname      TEXT NOT NULL DEFAULT '',
    action        TEXT NOT NULL DEFAULT '',
    client_id     TEXT NOT NULL,         -- HMAC hash, never raw IP
    decision      TEXT NOT NULL CHECK (decision IN ('allow','challenge','throttle','block')),
    score         REAL NOT NULL DEFAULT 0,
    degraded      BOOLEAN NOT NULL DEFAULT FALSE,
    simulated     BOOLEAN NOT NULL DEFAULT FALSE,
    method        TEXT NOT NULL DEFAULT '',
    path          TEXT NOT NULL DEFAULT '',
    reason        TEXT NOT NULL DEFAULT '',
    rules         TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts          ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_site_ts     ON events (site_key, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_decision_ts ON events (decision, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_action_ts   ON events (action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_client_ts   ON events (client_id, ts DESC);

CREATE TABLE IF NOT EXISTS admin_users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,           -- argon2id
    role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash    TEXT PRIMARY KEY,        -- SHA-256 of session token; token itself only in cookie
    user_id       BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    csrf_token    TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_ip_h  TEXT NOT NULL DEFAULT '' -- HMAC'd IP for audit, not raw
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,              -- e.g. site.create, policy.update, key.rotate
    target     TEXT NOT NULL DEFAULT '',
    detail     JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);

CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,     -- SHA-256; full key shown once at creation
    role         TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
    disabled     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

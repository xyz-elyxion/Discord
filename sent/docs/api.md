# HTTP API

Base path: `/v1`. All bodies are JSON. Errors use
`{"error": {"code": "...", "message": "..."}}` with appropriate HTTP status.

## Public endpoints

### `POST /v1/challenge`
Request a challenge.

```json
{ "siteKey": "my-site", "action": "contact-form" }
```

Response `200`:

```json
{
  "challenge": "<base64url signed blob>",
  "salt": "<random>",
  "difficulty": 18,
  "maxnumber": 262144,
  "signature": "<mac mirror>",
  "siteKey": "my-site",
  "action": "contact-form",
  "expiresIn": 120
}
```

Errors: `404 site`, `429` when locally rate-limited, `503` on issuance failure.

### `POST /v1/verify`
Exchange a solved nonce for a verification token.

```json
{ "siteKey": "my-site", "action": "contact-form",
  "challenge": "...", "salt": "...", "difficulty": 18,
  "signature": "...", "nonce": "<base64url>", "hostname": "example.com" }
```

Response `200`:

```json
{ "verified": true, "token": "<base64url>.<base64url>", "expiresIn": 120 }
```

Errors: `400 invalid_json|missing_fields|verification_failed|challenge_expired|challenge_replay`, `404 site`,
`500 token`.

### `POST /v1/token/validate`
Direct REST verification for server-side integrations.

```json
{ "siteKey": "my-site", "token": "...", "hostname": "example.com", "action": "contact-form" }
```

Response `200` `{ "verified": true, "siteKey": "...", "action": "...", "hostname": "...", "expiresAt": <unix> }`

Errors: `400 token_invalid|token_expired|token_replayed|token_binding|token_signature`.

### `GET /v1/health` — liveness (always 200 when the process is up).
### `GET /v1/ready` — readiness; 503 + `{"postgres":"down"}` when the DB is offline.
### `GET /metrics` — Prometheus exposition.

## Admin endpoints

All admin endpoints require the session cookie (set by `POST /v1/auth/login`)
and, for mutations, the `X-CSRF-Token` header returned by login/me.
Roles: `viewer` < `operator` < `admin`.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/login` | — | Sign in (rate limited per username) |
| POST | `/v1/auth/logout` | viewer | End the session |
| GET | `/v1/auth/me` | viewer | Session + CSRF introspection |
| GET | `/v1/sites` | viewer | List sites |
| POST | `/v1/sites` | admin | Create site; returns the per-site secret **once** |
| DELETE | `/v1/sites/{key}` | admin | Remove site (cascades policies) |
| POST | `/v1/sites/{key}/rotate` | admin | Rotate the per-site secret |
| GET | `/v1/policies?siteKey=` | viewer | List route policies |
| POST | `/v1/policies` | operator | Upsert a policy keyed by site+name |
| GET | `/v1/events` | viewer | Query events (filters: siteKey, decision, action, rule, limit≤1000, offset) |
| GET | `/v1/analytics?siteKey=&hours=1..720` | viewer | Hourly aggregates |
| GET | `/v1/audit?limit=` | viewer | Recent audit entries |

Errors: `401 unauthorized` (no/expired session), `403 forbidden|csrf|disabled`,
`429 rate_limited` on login, `502/503 storage` when Postgres is unavailable.

## Rate limits

- Login: 10 attempts / 10 min / username (in-process; set the `SENTINEL_REDIS_ADDR`
  env in clusters to share limits).
- Challenge generation: enforced per-client by the middleware policy (default
  site policy 60/min).
- All admin endpoints go through the same limiter as normal traffic.

## OpenAPI

An OpenAPI 3.1 snapshot is generated from the Go handlers in
`tests/openapi-snapshot.json` (checked in CI to catch drift).

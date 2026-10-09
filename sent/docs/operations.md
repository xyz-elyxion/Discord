# Operations

## Deployment

```bash
docker compose up -d --build
docker compose exec server /usr/local/bin/migrate -dsn "$SENTINEL_PG_DSN"
SENTINEL_ADMIN_USER=... SENTINEL_ADMIN_PASSWORD=... \
  docker compose exec server /usr/local/bin/server -bootstrap
# unset SENTINEL_ADMIN_* after bootstrap in production
```

### TLS
Terminate TLS in your reverse proxy (nginx/Caddy/Traefik):
- Forward real client IP with `X-Forwarded-For` **from trusted proxies only**
  (set `TrustedProxies` in the config for the CIDR of your proxy network).
- HSTS recommended; Sentinel does not terminate TLS itself.

## Environment variables (see `env.example`)

| Variable | Required | Effect |
| --- | --- | --- |
| `SENTINEL_TOKEN_SECRET` | yes | HMAC secret for verification tokens (≥32 bytes) |
| `SENTINEL_PG_DSN` | yes | PostgreSQL connection string |
| `SENTINEL_PG_PASSWORD` | compose yes | postgres superuser password |
| `SENTINEL_REDIS_ADDR` | optional | shared replay + rate limits |
| `SENTINEL_CLIENT_PEPPER` | optional | stabilizes client hashes across restarts |
| `SENTINEL_ADMIN_USER` / `SENTINEL_ADMIN_PASSWORD` | bootstrap | first admin account |

## Backups

```bash
docker compose exec postgres pg_dump -U sentinel sentinel | gzip > sentinel-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c sentinel-2026-01-01.sql.gz | \
  docker compose exec -T postgres psql -U sentinel -d sentinel
```

## Upgrades

1. `git pull` the new image tag.
2. `docker compose build server`.
3. Run migrations (they are additive and idempotent).
4. `docker compose up -d server` (rolling restart).

## Rollback

1. Keep the previous image tag; `docker compose down server && docker compose up -d` with the older tag.
2. Migrations are forward-only by design; a rollback does **not** run old SQL.
   For destructive schema changes, restore the backup taken before upgrade.

## Retention and cleanup jobs

`DELETE FROM events WHERE ts < now() - interval 'X days'` is the retention
operation (via `cmd/migrate` or a cron). Recommended: 30 days for events,
`DELETE FROM admin_sessions WHERE expires_at < now()` nightly.

```cron
# crontab -e
17 3 * * * docker compose exec server /usr/local/bin/migrate -dsn "$SENTINEL_PG_DSN" >/dev/null
```

## Metrics

`GET /metrics` (Prometheus format):

- `sentinel_decisions_total{site, decision, degraded, simulated}`
- `sentinel_challenge_outcomes_total{outcome}`
- `sentinel_events_dropped_total`
- `sentinel_admin_login_total{result}`

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `POST /v1/challenge` returns `404 site` | Wrong `siteKey`, or site disabled in the dashboard |
| `400 challenge_expired` on solve | Client clock skew or solve took > `expiresIn` — SDK auto-retries once |
| `429` on login, even with right password | 10 fails within 10 min lock — wait, or restart server (in-memory limiter) |
| Dashboard shows `502 storage` | PostgreSQL unreachable; check `docker compose logs postgres` |
| Everything blocked after Flash-of-DB-down | Policy `failure_mode` set to `fail_closed`; consider `fail_open` for low-risk routes |
| Tokens rejected cross-site | `hostname` binding mismatch: confirm the SDK gets `location.host` under HTTPS |

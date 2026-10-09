# Security & privacy

## Security disclosure policy

Report vulnerabilities privately to **security@limeyguard.example** (PGP key
published at `/.well-known/security.txt` in deployments). We will:

1. Acknowledge within 72 hours.
2. Keep reporters updated weekly; no threats of legal action.
3. Credit reporters in release notes (opt-in).

Do not run automated scanners against infrastructure you do not own.

## What we collect (and why)

| Data | Why | Retention |
| --- | --- | --- |
| Decision (allow/challenge/throttle/block) | dashboard metrics & event explorer | configurable (default 30d) |
| HMAC-hashed client ID | aggregate, privacy-preserving rate limiting | same as events |
| Path, method | route-specific abuse detection | same as events |
| Triggered rule names | tuning and transparency | same as events |
| Admin actions | audit trail for key/site/policy changes | 90 days default |

**Not collected**: raw IPs (only salted HMAC), request/response bodies,
query strings, cookies, screen/fingerprint traits, form field values,
third-party analytics.

## Data minimization in code

- `httpx.ClientID` HMACs the client IP with `SENTINEL_CLIENT_PEPPER`
  (derived per-process if unset — note: derived pepper means IDs shuffle on
  restart; set the pepper explicitly in multi-instance deployments).
- `httpHeadersSubset` copies only `accept*`, `user-agent`, truncated to 120
  chars, and only when a rule needs it.
- Events written by the middleware **never** contain request bodies.

## Dependencies & licenses

All are permissively licensed and used via Go modules / npm:

| Dependency | License | Notes |
| --- | --- | --- |
| `github.com/jackc/pgx/v5` | MIT | PostgreSQL driver |
| `github.com/redis/go-redis/v9` | BSD-2-Clause | optional shared cache |
| `golang.org/x/crypto` | BSD-3-Clause | argon2id |
| `github.com/prometheus/client_golang` | Apache-2.0 | metrics |
| `esbuild` (build-time only) | MIT | bundling |

No cryptographic primitives are invented: SHA-256 + HMAC-SHA256 (FIPS
180-4 / RFC 2104) via Go's standard library and Web Crypto in browsers.

## Security checklist for operators

- [ ] `SENTINEL_TOKEN_SECRET` ≥ 32 random bytes; rotate annually.
- [ ] Redis configured in multi-instance deployments (otherwise replay
      protection is per-instance only).
- [ ] `SENTINEL_CLIENT_PEPPER` explicitly set in clusters.
- [ ] `SENTINEL_ADMIN_*` removed after bootstrap.
- [ ] TLS terminating proxy; paranoid `sslmode=verify-full` for PG.
- [ ] `fail_open` only for low-risk routes.
- [ ] Periodic restore test of `pg_dump` backups.
- [ ] dependency review: `go list -m all` vs the table above.

## Cryptography invariants

1. Challenge MAC binds `{siteKey, action, expiresAt, challengeID}`.
2. Token MAC binds `{version, siteKey, action, hostname, expiresAt, jti}`.
3. MACs are compared with constant-time primitives only.
4. PV = proof-of-work verifies on the server, never client claims alone.

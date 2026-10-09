# Architecture

## Overview

```
 Browser                     Protected site                    Sentinel
┌──────────┐   GET sdk.js   ┌──────────────┐              ┌──────────────┐
│ LimeyGuard│◀──────────────│              │              │  ┌──────────┐│
└────┬─────┘                │   backend    │  token check │  │  core    ││
     │  POST /v1/challenge  │  (Go/Node/…) │◀────────────▶│  │ (server) ││
     │  solve PoW (crypto)  │              │  X-Sentinel- │  └────┬─────┘│
     │  POST /v1/verify     │  middleware  │  Token hdr   │       │
     └──────────────────────▶              │              │  ┌────▼─────┐│
                            └──────────────┘              │ PostgreSQL││
                                                          │  + Redis ││
                                                          └──────────┘│
                                                          └──────────────┘
```

## Packages

- `internal/challenge` — stateless, HMAC-bound proof-of-work challenges
  (browser solves `SHA256(salt||nonce)` with N leading zero bits). Expiry,
  site, workload and action are authenticated by the per-site secret, so
  challenge blobs cannot be forged or shifted to other actions/sites.
- `internal/verification` — issued tokens are `base64url(payload).base64url(HMAC)`.
  Separate global `SENTINEL_TOKEN_SECRET` (a site can never mint tokens for
  other sites), versioned payloads, replay-store interface.
- `internal/detection` — plugin rule engine; each rule returns a weight +
  recommendation. Current rules: unverified-traffic penalty, token replay,
  challenge failure rate, burst rate, repeated identical submissions, header
  anomalies. New models plug in via `Rule` without touching the engine.
- `internal/policy` — threshold mapping {allow, challenge, throttle, block},
  per-route overrides, allowlist/denylist short-circuits, fail-open/closed
  and simulation mode.
- `internal/ratelimit` — fixed-window quotas with atomic Redis INCR or
  bounded in-memory fallback; both implementations satisfy the same
  interface so decisions degrade safely and observably.
- `internal/httpx` — the `net/http` middleware and trusted-proxy IP logic.
- `internal/storage` — pgx-backed persistence with bounded, buffered event
  writes (events drop rather than block request handling; the drop is a
  metric, not a silent gap).
- `internal/auth` — argon2id password hashing, session cookie handling, RBAC.
- `internal/metrics` — Prometheus counters for every decision/outcome.

## Data flow

1. Browser GETs the protected page; the site's JS calls `LimeyGuard.protect`.
2. SDK POSTs `/v1/challenge` (siteKey + action); server returns a signed blob.
3. SDK solves locally (pure Web Crypto, no eval, no third parties).
4. SDK POSTs `/v1/verify`; server checks hash difficulty, expiry, HMAC, then
   marks the challenge consumed and issues an expiring signed token.
5. The site's backend receives the token (header for API calls, or as a
   hidden field / cookie for form posts) and validates it via middleware or
   `POST /v1/token/validate`.
6. Central middleware records an event (decision + rules) for the dashboard.

## Trust boundaries

- The browser is never trusted: tokens are only valid after server-side
  verification; the client-visible `Signature` field is informational —
  the authoritative MAC is inside the HMAC-bound challenge blob.
- Dashboard sessions are protected by HttpOnly SameSite=Lax cookies and
  CSRF tokens on mutation; the admin API is separated from public endpoints
  and role-checked server-side on every request.
- Public challenge endpoints are cheap to serve (single HMAC + rand) but
  bounded: per-client challenge generation is rate-limited by middleware.

## References

The reference repository `altcha-org/altcha` was inspected for its *public
documentation* of challenge flow only. Its non-core Sentinel backend under
`sentinel/` (Node/TypeScript, `db/`, `redis/`, `worker/`, `ui/`, `html/`)
is proprietary (`SL License`) and is NOT vendored, copied or adapted. All
Limey Guard code in this repository is original and MIT-licensed.

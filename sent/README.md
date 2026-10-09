# 🍋 Limey Guard

Self-hosted, privacy-conscious anti-bot and traffic protection, inspired by the
publicly documented functionality of ALTCHA Sentinel. Original implementation,
branding and code — no proprietary source is used (see `docs/threat-model.md`
and the reference licensing note below).

| Component     | Tech                                        |
| ------------- | ------------------------------------------- |
| Security core | Go (challenge PoW, HMAC tokens, rule engine, policy, rate limiting, middleware) |
| API           | REST `/v1` with JSON errors                 |
| Persistence   | PostgreSQL                                  |
| Shared cache  | Redis with in-memory fallback               |
| Admin console | React-free TypeScript-hearted JS SPA served by the Go server |
| Browser SDK   | `sdk/browser/sdk.js` (Web Crypto SHA-256 PoW) |
| Integrations  | Go middleware, Node/Express middleware, direct REST |

## Quickstart (fresh install, no SaaS)

```bash
# 1. generate secrets (placeholders in env.example)
openssl rand -hex 32   # → SENTINEL_TOKEN_SECRET
openssl rand -hex 16   # → SENTINEL_CLIENT_PEPPER + SENTINEL_PG_PASSWORD

cp env.example sentinel.env   # fill every <> placeholder

# 2. start with docker
export $(grep -v '^#' sentinel.env | xargs -d '\n')
docker compose up -d --build

# 3. apply migrations and create the first admin
docker compose exec server /usr/local/bin/migrate -dsn "$SENTINEL_PG_DSN"
SENTINEL_ADMIN_USER=admin SENTINEL_ADMIN_PASSWORD='long enough password' \
  docker compose exec server /usr/local/bin/server -bootstrap

# 4. open the console
open http://localhost:8080/
```

## Protect a form in three lines

```html
<script src="https://your-sentinel.example.com/sdk.js" defer></script>
```

```js
const guard = await LimeyGuard.protect({
  sentinelUrl: "https://your-sentinel.example.com",
  siteKey: "PUBLIC_SITE_KEY",       // from the Sites page
  action: "contact-form",
});
if (guard.verified) {
  // attach the token when submitting your form
}
```

Your backend then validates the token server-side (never trust the browser):

**Go**

```go
guard, _ := sentinelguard.New(sentinelguard.Config{TokenSecret: os.Getenv("SENTINEL_TOKEN_SECRET")})
http.Handle("/api/contact", guard.Middleware("my-site-key", contactHandler))
```

**Node / Express**

```js
app.post("/api/contact",
  sentinelGuard({ tokenSecret: process.env.SENTINEL_TOKEN_SECRET, siteKey: "my-site-key", action: "contact-form" }),
  handler);
```

**Direct REST** — `POST /v1/token/validate` with `{siteKey, token, hostname, action}`.

## Repository map

```
sent/
├── cmd/            server + migrate binaries
├── internal/       challenge, verification, detection, policy, ratelimit, events, auth, storage, httpx, dashboard, metrics
├── sdk/browser/    browser SDK (solve PoW with Web Crypto)
├── integrations/   go + node server-side verification libs
├── dashboard/      admin console source (built into internal/dashboard/static)
├── migrations/     SQL schema
├── deployments/    ops snippets (nginx, systemd)
├── docs/           architecture, threat-model, api, integration, operations, security
└── tests/          cross-component tests
```

## Run locally (dev, no docker)

Requires Go 1.22+ and a local PostgreSQL:

```bash
cd sent
go test ./...               # full unit suite
SENTINEL_PG_DSN=postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable \
SENTINEL_TOKEN_SECRET=$(openssl rand -hex 32) \
go run ./cmd/migrate
SENTINEL_ADMIN_USER=admin SENTINEL_ADMIN_PASSWORD='long enough password' \
SENTINEL_PG_DSN=... SENTINEL_TOKEN_SECRET=... go run ./cmd/server -bootstrap
SENTINEL_PG_DSN=... SENTINEL_TOKEN_SECRET=... go run ./cmd/server
```

## Important security notes

- Proof-of-work raises spam cost; **it does not prove a visitor is human**.
  Adaptive rules and rate limits, not PoW alone, carry the protection.
- Difficulty is bounded on both server and SDK (`sent/internal/challenge`,
  max 22 bits ≈ a few seconds in a browser) to protect low-power devices.
- All client identities in events are salted HMACs of IPs; raw IPs are never
  stored. See `docs/security.md` for data-retention controls.
- The reference `altcha-org/altcha` repository is **not vendored** here:
  its non-core Sentinel code is proprietary, so Limey Guard implements
  equivalent behavior from public documentation only.

## License

MIT — original code in this repository. Dependency licenses are audited in
`docs/security.md` (all permissively licensed: pgx, go-redis, x/crypto,
jwt-free HMAC design, prometheus client).

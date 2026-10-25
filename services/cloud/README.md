# LimeyCloud (settings sync backend)

This is the settings-sync backend for Limey V1 (AGPL-3.0, © Limey and contributors).

It is a small Go service backed by **Redis** that stores user settings, handles Discord OAuth
authorization, and serves the same `/v1` API the client's Settings Sync feature talks to:

- `GET /v1` — health check (`{"ping":"pong"}`)
- `GET /v1/oauth/settings` — OAuth configuration for the client
- `GET /v1/oauth/callback` — Discord OAuth callback
- `GET/HEAD/PUT/DELETE /v1/settings` — settings storage (auth via base64 `secret:userId` header)
- `DELETE /v1` — erase account

## Running

`server.js` (repo root) automatically starts the compiled binary at `cloud/limeycloud-backend`
on `127.0.0.1:3099` and proxies `/v1/*` to it.

Requirements:

- **Redis** reachable at `REDIS_URI` (default `127.0.0.1:6379`). The backend exits if Redis is down —
  the Node server then serves the site normally and just answers 503 on `/v1/*`.
- Optional env vars: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` (needed for
  the OAuth authorize flow), `PEPPER_SETTINGS`, `PEPPER_SECRETS`, `SIZE_LIMIT`, `ALLOWED_USERS`.

## Building the binary

```bash
cd cloud
CGO_ENABLED=0 go build -o ../cloud/limeycloud-backend .
```

(The Dockerfile does this automatically in a `golang:1.27-alpine` stage.)

# Integration guide

The SDK on its own is never the security boundary — always verify tokens
server-side. Below are the standard flows.

## 1. Contact form

```html
<form id="contact" method="POST" action="/api/contact">
  <input name="email" /> <textarea name="message"></textarea>
  <input type="hidden" name="sentinel_token" />
  <button>Send</button>
</form>
<script src="https://sentinel.example.com/sdk.js" defer></script>
<script>
  const form = document.getElementById("contact");
  LimeyGuard.protect({ sentinelUrl: "https://sentinel.example.com",
                       siteKey: "PUBLIC_SITE_KEY", action: "contact-form" })
    .then(g => { if (g.verified) form.elements.sentinel_token.value = g.token; });
  form.addEventListener("submit", async (e) => {
    // make sure protection completed before the backend validates the token
    if (!form.elements.sentinel_token.value) {
      const g = await LimeyGuard.protect({ sentinelUrl: "https://sentinel.example.com",
        siteKey: "PUBLIC_SITE_KEY", action: "contact-form" });
      if (g.verified) form.elements.sentinel_token.value = g.token;
      else e.preventDefault(); // show a friendly retry notice
    }
  });
</script>
```

Backend: require `sentinel_token`, validate via middleware or REST, then
process the form. On `token_expired`, simply ask the SDK to run again.

## 2. Registration / password reset / login

Use **one action name per flow** (e.g. `signup`, `login`, `pwreset`) so
successful tokens for one flow cannot feed another. Login endpoints should
additionally keep their normal server-side rate limiting — Sentinel adds
a layer, it does not replace rate limiting of failed logins.

## 3. Protecting API routes

For JSON APIs use the header form:

```js
const guard = await LimeyGuard.protect({ ... action: "api-write" });
fetch("/api/thing", { headers: { "X-Sentinel-Token": guard.token } });
```

**Go**

```go
guard, _ := sentinelguard.New(sentinelguard.Config{TokenSecret: os.Getenv("SENTINEL_TOKEN_SECRET")})
mux.Handle("/api/write/", guard.Middleware("my-site-key", "api-write", http.HandlerFunc(handler)))
```

**Node/Express**

```js
import { sentinelGuard } from "limey-guard-node";
app.post("/api/thing",
  sentinelGuard({ tokenSecret: process.env.SENTINEL_TOKEN_SECRET, siteKey: "my-site-key", action: "api-write" }),
  handler);
```

Both middlewares verify signature, expiry, site/action/hostname binding and
reject replay.

## 4. Generic reverse proxy integration

Deploy Sentinel in front of an existing origin with nginx:

```nginx
location /api/contact {
  # Authenticating proxy outreach happens in one of two ways:
  # (a) the origin calls POST /v1/token/validate (recommended), or
  # (b) auth_request against Sentinel:
  auth_request /_sentinel_auth;
  proxy_pass http://origin:3000;
}

location = /_sentinel_auth {
  internal;
  proxy_pass              http://sentinel:8080/v1/token/validate;
  proxy_set_header        Content-Type application/json;
  proxy_set_header        X-Sentinel-Origin-Host $host;
  proxy_pass_request_body off;
  # Forward the submitted token as JSON body — see deployments/nginx.conf
}
```

See `deployments/nginx.conf` for a complete, working snippet using
`auth_request`, including the body-copy workaround for `auth_request`.

## 5. Avoiding legitimate-user lockouts

- Start every new route in **simulation mode** (`simulation: true`) before
  enforcing; watch the event explorer for a few hours.
- Keep challenge difficulty ≤ 18 bits for route patterns reachable from
  mobile networks; the SDK and server both enforce a 22-bit ceiling.
- Prefer `challenge` over `block` for borderline risk so a human still gets
  through with one tap.
- Rate limits: pick defaults `60/min/IP` for forms; aggressive `block`
  thresholds only for endpoints that have no legitimate fast repeat.

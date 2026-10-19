# `@limeyv1/sdk`

Official SDK for connecting Discord bots to **Limey V1** — the Discord client mod
and its platform (economy, plugin store, ban registry, community data).

Zero dependencies. Node 18+. Works with any bot stack (discord.js, oceanic.js,
Eris, raw REST) because it only talks to the Limey V1 web server, never to
Discord directly.

```bash
pnpm add @limeyv1/sdk
# or, in this monorepo:
pnpm build   # puts src/index.js + types into dist/
```

```js
import { LimeyV1 } from "@limeyv1/sdk";
// Local/dev (this monorepo) — import by path instead:
// import { LimeyV1 } from "./packages/limey-v1-sdk/dist/index.js";

const limey = new LimeyV1();                       // production by default
const limey = new LimeyV1({ baseUrl: "http://localhost:3000",
                            adminToken: process.env.USRBG_ADMIN_TOKEN });
```

## Resources

| Resource | What it gives your bot |
| --- | --- |
| `limey.status` | The platform banner (outage / rate-limit notices) shown on limey-discord.onrender.com |
| `limey.bans` | Boot-time ban checks — keep your forked client mods aligned with the official ban registry |
| `limey.limes` | The **Limes** virtual economy: wallets, daily claims, message/voice/stream/game earning, perk tiers |
| `limey.plugins` | The approved community plugin store |
| `limey.detector` | Which users are currently running Limey V1 (5-minute TTL) |
| `limey.tools` | Invite / guild lookups backed by Discord's public API |
| `limey.sentinel` | Complete the Limey Sentinel (proof-of-work) puzzle in-process |
| `limey.state` | `/v1/bot-state/*` kv store the limebot itself uses — needs `USRBG_ADMIN_TOKEN` |

## Quick start

```js
const limey = new LimeyV1();

// 1. Show the platform banner when your bot boots.
const banner = await limey.status.get();
if (banner.active) console.log("[limey]", banner.message);

// 2. Ban registry — check any user before trust-sensitive actions.
const banned = await limey.bans.isBanned("123456789012345678");

// 3. Community plugin listing on a /plugins command.
const plugins = await limey.plugins.list();
// → [{ name, description, ... }]
```

## Limes economy

```js
// Wallet overview (balance, streak, tier, multiplier, nextDailyAt):
const wallet = await limey.limes.wallet(userId);
console.log(`${wallet.balance} Limes · tier ${wallet.tier}`);

// Everything the server awards is always computed server-side; you just
// forward the activity. All earning endpoints accept a Discord user id.

// Daily claim (server enforces the 20h cooldown, returns 429 when early):
const claim = await limey.limes.claimDaily(userId);
// claim = { amount, balance, streak, streakBonus, multiplier }
// claim.nextDailyAt lets you schedule reminders without hardcoding rates —
// but they exist too, for your UI:
import { LIMES_RATES } from "@limeyv1/sdk";

// Batch message activity (1 Lime per 25 messages, capped server-side):
await limey.limes.countMessages(userId, 25);

// Voice / streaming / game minutes, awarded per 15-minute block:
await limey.limes.countVoice(userId, 15);
await limey.limes.countStreaming(userId, 15);
await limey.limes.countGame(userId, 15);

// Perk tiers:
const { tiers } = await limey.limes.tiers();          // Seedling/Grove/Orchard
await limey.limes.startTrial(userId, "seedling");      // once per tier, ever
await limey.limes.subscribe(userId, "orchard");        // costs Limes
```

**Tip:** batch `countMessages` from your message gateway instead of hitting it
per message — the server caps per-day totals, and one request per burst is
friendlier to your own bot's rate limits.

## Human verification (Sentinel)

Only needed when you replicate Limey's dashboard flows (daily claim from the
site, plugin submission). The admin-token `bot-state` routes never require it:

```js
const payload = await limey.sentinel.solveToken();     // base64url, ready to send
await limey.limes.claimDashboard?, ... { sentinel: payload } // shape taken from the challenge
```

`solveToken` brute-forces up to the challenge's `maxNumber`; raise
`solveToken(3_000_000)` if the server raises difficulty.

## Errors

Every failure throws a `LimeyV1Error` with a stable `code`:

| code | meaning |
| --- | --- |
| `network_error` | fetch failed / timed out (`status` = 0) |
| `rate_limited` | HTTP 429 after retries |
| `server_error` | HTTP 5xx after retries |
| `api_error` | other non-2xx (`data` holds the parsed body) |
| `sentinel_required` | 403 asking for the proof-of-work payload |
| `invalid_id` | malformed Discord snowflake passed by your code |
| `not_found` | e.g. unknown plugin name |

```js
import { LimeyV1, LimeyV1Error } from "@limeyv1/sdk";
try {
    await limey.limes.claimDaily(userId);
} catch (err) {
    if (err instanceof LimeyV1Error && err.code === "rate_limited") {
        // waiting for cooldown — could read err.data.nextDailyAt
    }
}
```

Retries are automatic for 429/5xx (2 attempts, growing backoff), and every
request carries a 15s timeout; both are tunable on the client.

## Community Plugin Store

```js
const list = await limey.plugins.list();       // [{ name, description, ... }]
const plugin = await limey.plugins.get("Better Folders");
```

## Admin token + `bot-state`

The **limebot** mirrors its SQLite feature tables into the server's Postgres
kv store so deploys don't wipe counting progress. Bots that plug into the same
ecosystem can do the same:

```js
const limey = new LimeyV1({ adminToken: process.env.USRBG_ADMIN_TOKEN });
await limey.state.set("my-feature", { enabled: true, since: Date.now() });
const cfg = await limey.state.get("my-feature");
```

Keys are restricted to `[A-Za-z0-9_-]{1,64}` (server-validated).

## Dry-run / testing

Pass `dryRun: true` to get simulated responses for every call without any
network access — handy for unit tests of your own handlers:

```js
const mock = new LimeyV1({ dryRun: true });
await mock.ping(); // { simulated: true, path: "/v1/status", method: "GET" }
```

## Local development / self-hosting

```js
new LimeyV1({ baseUrl: "http://localhost:3000" });
```
You can also point at your own deployment — `baseUrl` is all that changes.
Works with any host running the `server.js` app; there is no SDK-side coupling
to onrender.com beyond `DEFAULT_BASE_URL`.

## Package layout

```
packages/limey-v1-sdk/
├── src/index.js      # hand-written ESM client (single file)
└── dist/             # build output (index.js + index.d.ts)
```

`pnpm build` in the repo root runs `scripts/build-sdk.mjs`, which copies the
source to `dist/` and stamps the declaration file. Keep source and `.d.ts`
surface in sync when adding resources.

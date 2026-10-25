/**
 * Limey V1 SDK — connect your Discord bot to the Limey V1 platform.
 *
 * One entry point, `LimeyV1`, covering every public Limey V1 endpoint:
 *   - `client.status`      — active service banners / outages
 *   - `client.bans`        — boot-time ban checks for your client mods
 *   - `client.detector`    — Limey V1 presence signals for your users
 *   - `client.limes`       — the Limes virtual economy (wallets, dailies, tiers)
 *   - `client.plugins`     — community plugin store listings
 *   - `client.tools`       — invite/guild lookups
 *   - `client.channels`    — release-channel manifest (what actually ships vs proposed)
 *   - `client.sentinel`    — human verification challenges for your own forms
 *   - `client.state`       — bot <-> server key-value state (needs token)
 *   - `client.clientData`  — small per-user blobs for your own client mods
 *
 * Usage:
 *   import { LimeyV1 } from "@limeyv1/sdk";
 *   const limey = new LimeyV1({ adminToken: process.env.USRBG_ADMIN_TOKEN });
 *   const { banned } = await limey.bans.check("123456789012345678");
 */

/** Default production base URL for the Limey V1 web server. */
export const DEFAULT_BASE_URL = "https://limey-discord.onrender.com";

const VALID_ID = /^\d{5,25}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** HHMMSS-ish timestamp for error logs */
function ts() {
    const d = new Date();
    return d.toISOString().slice(11, 19);
}

export class LimeyV1Error extends Error {
    /**
     * @param {string} message - human readable explanation
     * @param {object} [meta]
     * @param {number|undefined} meta.status - HTTP status (0 = network error)
     * @param {string} meta.code - stable machine-readable code
     * @param {unknown} meta.data - parsed response body, when one exists
     * @param {Error} [meta.cause] - original network error, when applicable
     */
    constructor(message, meta = {}) {
        super(message);
        this.name = "LimeyV1Error";
        this.status = meta.status ?? 0;
        this.code = meta.code ?? "unknown";
        this.data = meta.data ?? null;
        if (meta.cause) this.cause = meta.cause;
    }
}

/** Thrown on non-2xx responses once retries are exhausted. */
class ApiError extends LimeyV1Error {}
/** Thrown when a request times out or the network fails outright. */
class NetworkError extends LimeyV1Error {}
/** Thrown when `sentinelGate` sees a `sentinel_required` style 403. */
class SentinelRequired extends LimeyV1Error {}

// ---------------------------------------------------------------------------
// Constants the bot can rely on — mirrors the server's economy rules so you
// never have to hardcode them in your own code.
// ---------------------------------------------------------------------------

/** Limes earning rates, per-15-minute voice block boundaries and so on. */
export const LIMES_RATES = Object.freeze({
    daily: Object.freeze({ amount: 50, cooldownMs: 20 * 60 * 60 * 1000 }),
    message: Object.freeze({ amount: 1, perMessages: 25, capPerDay: 100 }),
    voiceMinute: Object.freeze({ amount: 5, perMinutes: 15, capPerDay: 30 }),
    streaming: Object.freeze({ amount: 10, perMinutes: 15, capPerDay: 60 }),
    game: Object.freeze({ amount: 3, perMinutes: 15, capPerDay: 45 }),
    streakBonus: 25,
    streakCap: 7
});

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** True when a method is safe to auto-retry (idempotent-ish). */
function isRetriable(status) {
    return status === 429 || (status >= 500 && status < 600) || status === 0;
}

/**
 * Coalesce / retry-friendly HTTP layer shared by every resource.
 * Never calls back into resources — just does the wire work and throws
 * typed errors.
 */
export class HttpClient {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.adminToken = options.adminToken || "";
        this.timeoutMs = options.timeoutMs ?? 15_000;
        this.retries = options.retries ?? 2;
        this.userAgent = options.userAgent ?? "LimeyV1-SDK/1.0 (+discord bot)";
        this.logger = options.logger ?? null;
        this.dryRun = options.dryRun === true;
    }

    _log(kind, message) {
        if (this.logger?.[kind]) this.logger[kind](`[${ts()}] [LimeyV1] ${message}`);
    }

    /** Base headers for every request. */
    _headers(extra) {
        const headers = {
            "User-Agent": this.userAgent,
            Accept: "application/json",
            ...extra
        };
        if (this.adminToken && !headers.Authorization) {
            // Some endpoints (bot-state, status POST, usrbg admin) use this
            // shared admin token; the others simply ignore it.
            headers.Authorization = `Bearer ${this.adminToken}`;
        }
        if (this.adminToken && !headers["x-admin-token"]) {
            headers["x-admin-token"] = this.adminToken;
        }
        return headers;
    }

    async request(path, options = {}) {
        const {
            method = "GET",
            body = undefined,
            headers: extraHeaders = {},
            retries = this.retries,
            allowSetters = false
        } = options;

        if (this.dryRun) {
            return { simulated: true, path, method };
        }

        const headers = this._headers(extraHeaders);
        let payload;
        if (body !== undefined) {
            payload = JSON.stringify(body);
            headers["Content-Type"] = "application/json; charset=utf-8";
        }

        let attempt = 0;
        let lastErr;
        while (attempt <= retries) {
            attempt += 1;
            try {
                const res = await fetch(this.baseUrl + path, {
                    method,
                    headers,
                    body: payload,
                    signal: AbortSignal.timeout(this.timeoutMs)
                });

                if (res.ok) {
                    if (res.status === 204) return null;
                    return await res.json();
                }

                // The REST of the platform sends plain text 401/404s in some
                // spots; ensure we can read the response body either way.
                let data = null;
                let text = "";
                try {
                    text = await res.text();
                    if (text) data = JSON.parse(text);
                } catch {
                    data = text || null;
                }

                if (isRetriable(res.status) && attempt <= retries) {
                    this._log("warn", `${res.status} on ${method} ${path} — retrying`);
                    await sleep(300 * attempt);
                    lastErr = new ApiError(`Limey V1 returned ${res.status}`, {
                        status: res.status, code: "server_error", data
                    });
                    continue;
                }
                if (res.status === 403 && data?.code === "sentinel_required") {
                    throw new SentinelRequired(data.error || "sentinel required", {
                        status: 403, code: "sentinel_required", data
                    });
                }
                throw new ApiError(
                    data?.error || `Limey V1 returned ${res.status}`,
                    {
                        status: res.status,
                        code: res.status === 429 ? "rate_limited"
                            : res.status === 404 ? "not_found"
                            : "api_error",
                        data
                    }
                );
            } catch (err) {
                if (err instanceof LimeyV1Error) throw err;
                // fetch structure: network error (AbortError on timeouts)
                const message = err?.name === "TimeoutError" || err?.name === "AbortError"
                    ? `request timed out after ${this.timeoutMs}ms`
                    : `network error: ${err?.message || "unknown"}`;
                lastErr = new NetworkError(message, { status: 0, code: "network_error", cause: err });
                if (attempt <= retries) {
                    this._log("warn", `${message} on ${method} ${path} — retrying`);
                    await sleep(300 * attempt);
                    continue;
                }
            }
        }
        throw lastErr ?? new NetworkError("request failed", { status: 0, code: "network_error" });
    }

    /** Convenience: build a query string from an object (skips empty values). */
    static qs(params) {
        if (!params) return "";
        const usp = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null || value === "") continue;
            usp.append(key, String(value));
        }
        const s = usp.toString();
        return s ? `?${s}` : "";
    }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

class BaseResource {
    constructor(http) {
        this.http = http;
    }
}

/**
 * Status: active banners about the Limey platform.
 * `client.status.get()` gives `{ active, message, startedAt, updatedAt }`.
 */
class StatusResource extends BaseResource {
    /** The currently active banner (or an inactive placeholder). */
    async get() {
        return this.http.request("/v1/status");
    }
    /** Convenience: boolean, did the bot flag anything active? */
    async isActive() {
        const status = await this.get();
        return Boolean(status?.active);
    }
}

/**
 * Bans: boot-time ban checks for client mods you maintain.
 * The check is safe to call per-boot and never exposes who applied the ban.
 */
class BansResource extends BaseResource {
    /**
     * Check whether a Discord user id is banned from Limey V1.
     * Unless `throwOnBanned` is true (constructor option), this never throws.
     */
    async check(userId) {
        if (!VALID_ID.test(String(userId))) {
            throw new LimeyV1Error("invalid Discord user id", { code: "invalid_id" });
        }
        return this.http.request(`/v1/bans/check/${userId}`);
    }
    /** Whether the given user id is banned. */
    async isBanned(userId) {
        const res = await this.check(userId);
        return Boolean(res?.banned);
    }
}

/**
 * Detector: who's currently running Limey V1 (5-minute TTL on each entry).
 */
class DetectorResource extends BaseResource {
    /** Users that have been seen recently + coarse country coverage. */
    async users() {
        return this.http.request("/v1/detector/users");
    }
}

/**
 * Limes: the virtual economy. All writes take an explicit `userId` because
 * Limes trusts the plugin's authenticated Discord id over TLS.
 */
class LimesResource extends BaseResource {
    /** Client-side snowflake guard shared by every limes call. */
    _requireId(userId) {
        if (!VALID_ID.test(String(userId))) {
            throw new LimeyV1Error("invalid Discord user id", { code: "invalid_id" });
        }
        return String(userId);
    }

    /** Wallet, streak, tier and multiplier overview for a user. */
    async wallet(userId) {
        return this.http.request(`/v1/limes/wallet${HttpClient.qs({ userId: this._requireId(userId) })}`);
    }
    /** The full transaction ledger (newest first). */
    async history(userId) {
        return this.http.request(`/v1/limes/history${HttpClient.qs({ userId: this._requireId(userId) })}`);
    }
    /** The currently available perk tiers and their prices / perks. */
    async tiers() {
        return this.http.request("/v1/limes/tiers");
    }
    /** A user's active perk tier, trial state and expiry. */
    async perks(userId) {
        return this.http.request(`/v1/limes/perks${HttpClient.qs({ userId: this._requireId(userId) })}`);
    }
    /** Claim the daily reward. Server enforces the ~20h cooldown. */
    async claimDaily(userId) {
        return this.http.request("/v1/limes/earn/daily", { method: "POST", body: { userId: this._requireId(userId) } });
    }
    /** Message activity — batch the recent message count, not per-message hits. */
    async countMessages(userId, count) {
        return this.http.request("/v1/limes/earn/message", { method: "POST", body: { userId: this._requireId(userId), count } });
    }
    /** Voice minutes, per 15-minute blocks. */
    async countVoice(userId, minutes) {
        return this.http.request("/v1/limes/earn/voice", { method: "POST", body: { userId: this._requireId(userId), minutes } });
    }
    /** Streaming minutes. */
    async countStreaming(userId, minutes) {
        return this.http.request("/v1/limes/earn/stream", { method: "POST", body: { userId: this._requireId(userId), minutes } });
    }
    /** Game activity minutes. */
    async countGame(userId, minutes) {
        return this.http.request("/v1/limes/earn/game", { method: "POST", body: { userId: this._requireId(userId), minutes } });
    }
    /** Start a once-per-tier free trial. */
    async startTrial(userId, tier) {
        return this.http.request("/v1/limes/perks/trial", { method: "POST", body: { userId: this._requireId(userId), tier } });
    }
    /** Subscribe (or extend) a perk tier using Limes. */
    async subscribe(userId, tier) {
        return this.http.request("/v1/limes/perks/subscribe", { method: "POST", body: { userId: this._requireId(userId), tier } });
    }
    /** Redeem a donor code for a logged-in user (site session only). */
    async redeemDonationCode(token, code) {
        return this.http.request("/v1/limes/donation-codes/redeem", {
            method: "POST",
            body: { code },
            headers: { Authorization: `Bearer ${token}` }
        });
    }
}

/**
 * Plugins: the community plugin store.
 */
class PluginsResource extends BaseResource {
    /** Approved community plugins, sorted by name. */
    async list() {
        const res = await this.http.request("/v1/plugins/list.json");
        return res?.plugins ?? [];
    }
    /** Fetch a single plugin by name; throws not_found when absent. */
    async get(name) {
        const plugins = await this.list();
        const exact = plugins.find(p => p.name === name);
        if (exact) return exact;
        const fuzzy = plugins.find(p => p.name.toLowerCase() === String(name).toLowerCase());
        if (fuzzy) return fuzzy;
        throw new LimeyV1Error(`plugin "${name}" not found`, { code: "not_found", status: 404 });
    }
}

/**
 * Tools: invite and guild lookups backed by the public Discord REST API.
 */
class ToolsResource extends BaseResource {
    /** Resolve a Discord invite code into a public guild summary. */
    async lookupInvite(code) {
        return this.http.request(`/v1/tools/lookup/invite/${encodeURIComponent(String(code).replace(/^https?:\/\/.*\//, ""))}`);
    }
    /** Fetch a guild's widget.json (only works if the guild enabled it). */
    async lookupGuild(guildId) {
        if (!/^\d{10,25}$/.test(String(guildId))) {
            throw new LimeyV1Error("invalid guild id", { code: "invalid_id" });
        }
        return this.http.request(`/v1/tools/lookup/guild/${guildId}`);
    }
}

/**
 * Sentinel: complete a proof-of-work human check on the server's behalf so
 * you can programmatically claim dailies or submit plugins.
 *
 * You only need this if you bridge a Limey dashboard-facing flow; if you
 * don't want to run the puzzle, use the bot-state routes instead — no
 * sentinel needed there.
 */
class SentinelResource extends BaseResource {
    /** The raw challenge. */
    async challenge(query) {
        return this.http.request(`/v1/sentinel/challenge${HttpClient.qs(query)}`);
    }
    /**
     * Do the whole loop: fetch a challenge, brute-force a matching number,
     * return the ready-to-send base64url payload. Solved in your own process
     * `maxIterations` (default 3,000,000) — raise it for harder puzzles.
     */
    async solveToken(maxIterations = 3_000_000) {
        const { createHash } = await import("node:crypto");
        const challenge = await this.challenge();
        const maxNumber = Number(challenge.maxNumber) || 500_000;
        if (maxIterations < maxNumber) {
            throw new LimeyV1Error(
                `sentinel challenge needs up to ${maxNumber} iterations but cap is ${maxIterations}`,
                { code: "sentinel_cap_too_low" }
            );
        }
        for (let n = 0; n <= maxNumber; n += 1) {
            const hash = createHash("sha256").update(`${challenge.salt}${n}`).digest("hex");
            if (hash === challenge.challenge) {
                const payload = Base64Url.encode(JSON.stringify({ ...challenge, number: n }));
                return payload;
            }
        }
        throw new LimeyV1Error("sentinel solve ran out of iterations", { code: "sentinel_unsolved" });
    }
}

// Base64url — used only by sentinel payload encoding.
export const Base64Url = {
    encode(input) {
        const str = typeof input === "string" ? input : String(input);
        return Buffer
            .from(str, "utf8")
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }
};

/**
 * Channel categories in the /v1/channels registry (same order the server
 * serves them in). Used to validate byCategory() input.
 */
const CHANNEL_CATEGORIES = ["track", "host", "rollout", "maintenance"];

/**
 * Channels: the release-channel manifest from GET /v1/channels — the
 * machine-readable version of the "Release Channels" docs page. Only the
 * entries with `implemented: true` (stable, dev and the install targets)
 * ship artifacts today; the rest are proposed definitions from the spec.
 */
class ChannelsResource extends BaseResource {
    /** The full manifest: { schema, strategy, implementedOnly, channels }. */
    async manifest() {
        return this.http.request("/v1/channels");
    }
    /** Implemented + proposed channel definitions, sorted as served. */
    async list() {
        const manifest = await this.manifest();
        return manifest?.channels ?? [];
    }
    /** A single channel by id; throws not_found when unknown. */
    async get(id) {
        if (!/^[a-z0-9-]+$/.test(String(id))) {
            throw new LimeyV1Error("invalid channel id", { code: "invalid_id" });
        }
        // Prefer the direct endpoint; fall back to scanning the manifest so
        // self-hosted backends without /v1/channels/:id still work.
        try {
            const res = await this.http.request(`/v1/channels/${id}`);
            if (res?.channel) return res.channel;
        } catch (err) {
            if (!(err instanceof LimeyV1Error) || err.code !== "not_found") throw err;
        }
        const channels = await this.list();
        const found = channels.find(ch => ch.id === id);
        if (found) return found;
        throw new LimeyV1Error(`channel "${id}" not found`, { code: "not_found", status: 404 });
    }

    /** Only channels that actually ship artifacts today (implemented: true). */
    async implemented() {
        return (await this.list()).filter(ch => ch.implemented);
    }

    /** All channel definitions of a category: "track" | "host" | "rollout" | "maintenance". */
    async byCategory(category) {
        if (!CHANNEL_CATEGORIES.includes(category)) {
            throw new LimeyV1Error(`invalid channel category "${category}"`, { code: "invalid_category" });
        }
        return (await this.list()).filter(ch => ch.category === category);
    }

    /**
     * Implemented desktop install targets (host channels) with the matching
     * installer --branch value derived from the channel id, mirroring
     * GET /v1/install/desktop's `channels` object. The web host channel is
     * excluded — it installs via the browser extension, not the installer.
     */
    async installTargets() {
        const hosts = (await this.byCategory("host")).filter(ch => ch.implemented && /^discord-/.test(ch.id));
        return hosts.map(ch => ({
            channel: ch.id,
            name: ch.name,
            branch: ch.id.replace(/^discord-/, ""),
            description: ch.description
        }));
    }
}

/**
 * BotState: the /v1/bot-state/* key-value store the limebot itself uses to
 * persist feature data across deploys. Requires USRBG_ADMIN_TOKEN.
 */
class BotStateResource extends BaseResource {
    /** Read a value by key (key is limited to [A-Za-z0-9_-]{1,64}). */
    async get(key) {
        return this.http.request(`/v1/bot-state/${encodeURIComponent(key)}`);
    }
    /** Write a value (JSON) under a key. */
    async set(key, value) {
        return this.http.request(`/v1/bot-state/${encodeURIComponent(key)}`, {
            method: "PUT",
            body: value ?? null
        });
    }
}

/**
 * ClientData: tiny per-user blobs for your own client mods — only usable
 * when you run your own Limey-compatible backend. Included here so bots
 * that bridge both Limey and self-hosted data stores look uniform.
 */
class ClientDataResource extends BaseResource {
    get(key) {
        return this.http.request(`/v1/client-data/${encodeURIComponent(key)}`);
    }
    set(key, value) {
        return this.http.request(`/v1/client-data/${encodeURIComponent(key)}`, {
            method: "PUT",
            body: value ?? null
        });
    }
}

// ---------------------------------------------------------------------------
// Top-level client
// ---------------------------------------------------------------------------

export class LimeyV1 {
    /**
     * @param {object} [options]
     * @param {string} [options.baseUrl] - defaults to production
     * @param {string} [options.adminToken] - USRBG_ADMIN_TOKEN, for bot-state routes
     * @param {number} [options.timeoutMs=15000]
     * @param {number} [options.retries=2]
     * @param {object} [options.logger] - { info, warn, error } consumer
     * @param {boolean} [options.dryRun=false] - return simulated results only
     */
    constructor(options = {}) {
        const http = new HttpClient(options);
        this.http = http;

        this.status = new StatusResource(http);
        this.bans = new BansResource(http);
        this.detector = new DetectorResource(http);
        this.limes = new LimesResource(http);
        this.plugins = new PluginsResource(http);
        this.tools = new ToolsResource(http);
        this.channels = new ChannelsResource(http);
        this.sentinel = new SentinelResource(http);
        this.state = new BotStateResource(http);

        // Synonym some bot authors find more natural.
        this.botState = this.state;
    }

    /**
     * Convenience: resolve a Discord plugin/person id to whatever info the
     * platform is willing to expose. Exists for parity with bot payloads.
     */
    async ping() {
        return this.http.request("/v1/status", { method: "GET" });
    }
}

export default LimeyV1;

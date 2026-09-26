/*
 * Limey V1 — self-hosted Server Configuration backend
 * Mounted by server.js at /v1/server-config/*.
 *
 * Zero external dependencies. Per-guild plugin settings distributed to all
 * members. Data is persisted to data/server-config.json (optionally mirrored
 * to Redis by server.js via the kvSet/kvGet hooks).
 *
 * Owner auth: Discord OAuth2 (shared app + shared /v1/oauth/callback with
 * state=serverconfig). Guild ownership/managing is verified server-side via
 * the Discord API's /users/@me/guilds endpoint before a PUT is accepted —
 * the same guarantee as reviewdb-backend.js but scoped to guilds.
 *
 * Endpoints (all JSON, CORS enabled):
 *   GET  /v1/server-config/config                      -> { clientId, configured } (public OAuth app id)
 *   GET  /v1/server-config/auth?code=...               -> { token }               (OAuth2 code exchange, identifies scopes: identify guilds)
 *   GET  /v1/server-config/guilds                      -> { guilds: [...] }       (auth; guilds user owns/manages)
 *   GET  /v1/server-config/<guildId>                   -> { disabledPlugins }     (public read — every member's client uses this)
 *   PUT  /v1/server-config/<guildId>                   -> { ok }                  (owner/manager token OR X-Admin-Token fallback)
 */

"use strict";

const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_FILE = join(ROOT, "data", "server-config-auth.json");

const DISCORD_API = "https://discord.com/api/v10";

// Same OAuth app as reviewdb (shared DISCORD_CLIENT_ID/SECRET env).
const CLIENT_ID = process.env.REVIEWDB_CLIENT_ID || process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.REVIEWDB_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.REVIEWDB_REDIRECT_URI || "https://limey-discord.onrender.com/v1/oauth/callback";

// Optional admin fallback: bypasses OAuth (site-wide admin).
const ADMIN_TOKEN = process.env.SERVER_CONFIG_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN || "";

// --- Data store --------------------------------------------------------------
// {
//   tokens:       { [token]: discordId },
//   owners:       { [guildId]: discordId[] } // cached list of verified owners/managers per guild
//   configs:      { [guildId]: { disabledPlugins: string[] } }
// }
let db = {
    tokens: {},
    owners: {},
    configs: {},
};

try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    db = { ...db, ...parsed };
} catch { /* fresh database */ }

let saveTimer = null;
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        if (typeof global.__reviewdbKvSet === "function") {
            global.__reviewdbKvSet("limey:server-config-auth", db);
        }
        try {
            mkdirSync(join(ROOT, "data"), { recursive: true });
            writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
        } catch (err) {
            if (!global.__reviewdbKvSet) {
                console.error("[server-config] failed to persist data:", err.message);
            }
        }
    }, 3000);
}

// Hydrate from Redis at startup (server.js calls hydrate with the kv value).
function hydrate(value) {
    if (!value || typeof value !== "object") return;
    db = { ...db, ...value };
    console.log("[server-config] hydrated database from Redis");
}

// --- Helpers ------------------------------------------------------------------
function json(res, status, obj) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 1e6) { reject(new Error("body too large")); req.destroy(); }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

function getAuth(req) {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const discordId = db.tokens[token];
    if (!discordId) return null;
    return { token, discordId };
}

function isAdmin(req) {
    return Boolean(ADMIN_TOKEN) && (req.headers["x-admin-token"] === ADMIN_TOKEN);
}

async function exchangeCode(code) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw Object.assign(new Error("Server Configuration backend is not configured: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET"), { status: 503 });
    }

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
    });

    const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        throw Object.assign(new Error(`Discord token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`), { status: 401 });
    }
    const { access_token } = await tokenRes.json();

    const meRes = await fetch(DISCORD_API + "/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) {
        throw Object.assign(new Error(`Discord @me failed (${meRes.status})`), { status: 401 });
    }
    return { me: await meRes.json(), accessToken: access_token };
}

// Fetches the guilds the identified user owns or manages.
async function fetchManagedGuilds(discordUserAccessToken) {
    const res = await fetch(DISCORD_API + "/users/@me/guilds?with_counts=true", {
        headers: { Authorization: `Bearer ${discordUserAccessToken}` }
    });
    if (!res.ok) {
        throw Object.assign(new Error(`Discord guilds fetch failed (${res.status})`), { status: 401 });
    }
    const guilds = await res.json();
    // MANAGE_GUILD permission = 1 << 5 = 32. Owner flag comes directly from Discord.
    return guilds.filter(g => g.owner || (BigInt(g.permissions) & 32n) === 32n);
}

// Verify the user can manage this guild (cached, refreshed on demand).
async function canManageGuild(discordId, guildId, discordUserAccessToken) {
    const cached = db.owners[guildId];
    if (cached?.includes(discordId)) return true;

    if (!discordUserAccessToken) {
        // We only have the user's token at OAuth time; if we don't have a
        // fresh access token we must have cached them already.
        return false;
    }

    const managed = await fetchManagedGuilds(discordUserAccessToken);
    const guild = managed.find(g => g.id === guildId);
    if (!guild) return false;

    db.owners[guildId] ??= [];
    if (!db.owners[guildId].includes(discordId)) db.owners[guildId].push(discordId);
    save();
    return true;
}

// For PUT: the user must be a verified owner/manager of the target guild.
// We can't reuse their short-lived OAuth access_token after the flow, so we
// rely on the db.owners cache which was populated at authorization time.
async function canManageGuildCached(discordId, guildId) {
    return Boolean(db.owners[guildId]?.includes(discordId));
}

// --- Route handlers --------------------------------------------------------------
async function handle(req, res, url) {
    const queryIndex = url.indexOf("?");
    const query = queryIndex === -1 ? "" : url.slice(queryIndex);
    const path = url.slice("/v1/server-config".length, queryIndex === -1 ? undefined : queryIndex) || "/";
    const method = req.method;

    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token"
        });
        return res.end(), true;
    }

    // Public OAuth app config so the plugin can start the OAuth flow
    if (method === "GET" && path === "/config") {
        return json(res, 200, { clientId: CLIENT_ID, configured: Boolean(CLIENT_ID && CLIENT_SECRET) }), true;
    }

    // OAuth2 code exchange -> { token }. Requires "identify guilds" scopes so
    // we can verify which guilds the user owns/manages.
    if (method === "GET" && path === "/auth") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const code = params.get("code");
        if (!code) return json(res, 400, { message: "missing code parameter" }), true;

        try {
            const { me, accessToken } = await exchangeCode(code);
            const token = crypto.randomBytes(32).toString("hex");

            db.tokens[token] = me.id;

            // Cache the guilds this user owns/manages NOW, while we still hold
            // their OAuth access token — PUT verification relies on this cache.
            try {
                const managed = await fetchManagedGuilds(accessToken);
                for (const g of managed) {
                    db.owners[g.id] ??= [];
                    if (!db.owners[g.id].includes(me.id)) db.owners[g.id].push(me.id);
                }
            } catch (err) {
                console.error("[server-config] failed to cache managed guilds:", err.message);
            }

            save();

            return json(res, 200, { token, discordId: me.id }), true;
        } catch (err) {
            return json(res, err.status ?? 500, { message: err.message }), true;
        }
    }

    // List guilds the authenticated user owns/manages (auth)
    if (method === "GET" && path === "/guilds") {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;
        return json(res, 200, { guilds: Object.keys(db.owners).filter(id => db.owners[id].includes(auth.discordId)) }), true;
    }

    // Read a guild's config (public) — this is what member clients consume.
    const guildMatch = /^\/([0-9]{5,25})$/.exec(path);
    if (guildMatch) {
        const guildId = guildMatch[1];

        if (method === "GET") {
            const entry = db.configs[guildId] ?? { disabledPlugins: [] };
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache"
            });
            return res.end(JSON.stringify(entry)), true;
        }

        if (method === "PUT") {
            // Admin token bypass (site admin)
            if (!isAdmin(req)) {
                const auth = getAuth(req);
                if (!auth) return json(res, 401, { message: "Unauthorized: missing Bearer token" }), true;
                if (!(await canManageGuildCached(auth.discordId, guildId))) {
                    return json(res, 403, { message: "You don't manage this server (re-authorize if you became owner recently)" }), true;
                }
            }

            let body;
            try { body = JSON.parse(await readBody(req) || "{}"); } catch {
                return json(res, 400, { message: "invalid JSON body" }), true;
            }
            if (typeof body !== "object" || body === null || Array.isArray(body)) {
                return json(res, 400, { message: "expected object" }), true;
            }
            if (!Array.isArray(body.disabledPlugins) || body.disabledPlugins.some(p => typeof p !== "string")) {
                return json(res, 400, { message: "expected disabledPlugins: string[]" }), true;
            }

            db.configs[guildId] = { disabledPlugins: body.disabledPlugins.slice(0, 100) };
            save();
            return json(res, 200, { ok: true }), true;
        }
    }

    return json(res, 404, { message: "not found" }), true;
}

module.exports = { handle, hydrate };

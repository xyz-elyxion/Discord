/*
 * Limey V1 — static hosting server
 * Serves the website (public/) and build artifacts (dist/) with plain Node.js.
 * No external dependencies required.
 */

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("fs");
const { join, extname, normalize, resolve } = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");
const CLOUD_BIN = join(ROOT, "cloud", "limeycloud-backend");
const CLOUD_PORT = Number(process.env.CLOUD_PORT) || 3099;
const CLOUD_HOST = "127.0.0.1";

// ------------------------------------------------------------------
// Persistent storage — PostgreSQL (Supabase) via the `pg` client.
// Uses the DATABASE_URL env var. When it is not set, falls back to local
// JSON files in data/ (local dev). See pgkv.js.
const net = require("net");

// ------------------------------------------------------------------
// Backend-provided install: the server packages the browser extension
// zip itself (in-process, using fflate) so the install is always fresh
// and never depends on a possibly stale/missing build artifact.
// ------------------------------------------------------------------
const EXTENSION_ZIP_PATH = join(DIST, "LimeyV1-Extension.zip");
const EXTENSION_FILES = [
    "browser/manifest.json",
    "browser/manifestv2.json",
    "browser/background.js",
    "browser/content.js",
    "browser/service-worker.js",
    "browser/GMPolyfill.js",
    "browser/patch-worker.js",
    "browser/modifyResponseHeaders.json",
    "browser/icon.png",
    "dist/browser.js",
    "dist/browser.css",
];
const EXTENSION_VENDOR_FILES = ["dist/vendor/monaco/index.js"];

/**
 * Build the extension zip in-process. Returns the zip Buffer, or null if
 * the built mod bundle (dist/browser.js) is missing.
 * Results are cached in memory until the bundle changes (mtime check).
 */
let extZipCache = null;
let extZipCacheKey = "";

function buildExtensionZip() {
    const bundlePath = join(DIST, "browser.js");
    if (!existsSync(bundlePath)) {
        console.error("[install] dist/browser.js missing — run `pnpm buildWeb` first");
        return null;
    }

    // Rebuild the cache when the bundle mtime changes
    const key = String(statSync(bundlePath).mtimeMs);
    if (extZipCache && key === extZipCacheKey) return extZipCache;

    const files = [...EXTENSION_FILES, ...EXTENSION_VENDOR_FILES];
    const zipData = {};
    for (const file of files) {
        try {
            zipData[file] = new Uint8Array(readFileSync(join(ROOT, file)));
        } catch { /* optional file missing (e.g. monaco vendor) — skip */ }
    }

    let zipSync;
    try {
        ({ zipSync } = require("fflate"));
    } catch (err) {
        console.error("[install] fflate unavailable:", err.message);
        return null;
    }
    const zipped = Buffer.from(zipSync(zipData, { level: 9 }));

    extZipCache = zipped;
    extZipCacheKey = key;
    // Also write it to disk so /dist/LimeyV1-Extension.zip keeps working
    try {
        mkdirSync(DIST, { recursive: true });
        writeFileSync(EXTENSION_ZIP_PATH, zipped);
    } catch (err) {
        console.error("[install] failed to write zip to disk:", err.message);
    }
    return zipped;
}

// Ready-built desktop package: dist artifacts + a one-command installer
// script the user runs locally — no compiling on their machine.
const DESKTOP_FILES = [
    "dist/patcher.js",
    "dist/renderer.js",
    "dist/preload.js",
    "dist/limeyV1DesktopMain.js",
    "dist/limeyV1DesktopRenderer.js",
    "dist/limeyV1DesktopPreload.js",
];

let desktopZipCache = null;
let desktopZipKey = "";

function buildDesktopZip() {
    if (!existsSync(join(DIST, "patcher.js"))) return null;
    const key = DESKTOP_FILES.map(f => {
        const p = join(ROOT, f);
        return existsSync(p) ? statSync(p).mtimeMs : "-";
    }).join(",");
    if (desktopZipCache && key === desktopZipKey) return desktopZipCache;

    let zipSync;
    try { ({ zipSync } = require("fflate")); } catch { return null; }

    const zipData = {};
    for (const f of DESKTOP_FILES) {
        try { zipData[f] = new Uint8Array(readFileSync(join(ROOT, f))); } catch { /* optional */ }
    }
    zipData["install-desktop.mjs"] = new TextEncoder().encode(`
// Limey V1 desktop installer — run:  node install-desktop.mjs
// Injects the bundled build into your Discord client (same as pnpm inject).
const { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } = require("fs");
const { join } = require("path");
const { homedir, platform } = require("os");

const home = homedir();
const candidates = platform() === "win32"
    ? [join(home, "AppData", "Roaming", "discord")]
    : platform() === "darwin"
        ? [join(home, "Library", "Application Support", "discord")]
        : [join(home, ".config", "discord")];
const discordDir = candidates.find(existsSync);
if (!discordDir) {
    console.error("Discord desktop install folder not found — is Discord installed?");
    process.exit(1);
}
const appDirs = readdirSync(discordDir).filter(d => d.startsWith("app-")).sort().reverse();
if (!appDirs.length) { console.error("No app-* folder found in", discordDir); process.exit(1); }
const appDir = join(discordDir, appDirs[0]);
const resourcesDir = join(appDir, "resources");
const injectDir = join(resourcesDir, "app");
console.log("Injecting Limey V1 into", appDir);

if (!existsSync(join(resourcesDir, "app.orig.asar"))) {
    copyFileSync(join(resourcesDir, "app.asar"), join(resourcesDir, "app.orig.asar"));
}
rmSync(injectDir, { recursive: true, force: true });
mkdirSync(injectDir, { recursive: true });
copyFileSync("patcher.js", join(injectDir, "index.js"));
writeFileSync(join(injectDir, "package.json"), JSON.stringify({ main: "index.js", name: "limeyV1", private: true }));
console.log("Done! Restart Discord — Limey V1 appears in Settings.");
console.log("To remove: delete", injectDir, "and restore app.asar from app.orig.asar.");
`);
    const zipped = Buffer.from(zipSync(zipData, { level: 9 }));
    desktopZipCache = zipped;
    desktopZipKey = key;
    return zipped;
}

function handleInstall(req, res, url) {
    // Serve the desktop build files to the Go installer, stamped with the
    // build hash (first line of patcher.js: "// Limey V1 <hash>") so the
    // installer can detect installed vs latest.
    if (url.startsWith("/v1/install/files/")) {
        const name = url.slice("/v1/install/files/".length);
        if (!/^[\w.-]+\.(js|css)$/.test(name)) return json(res, 400, { error: "invalid file name" }), true;
        const filePath = join(DIST, name);
        if (!existsSync(filePath)) return json(res, 404, { error: "file not found — is the build ready?" }), true;

        let content = readFileSync(filePath);
        if (name.endsWith(".css")) {
            // The installer fetches renderer.css only to read the hash comment.
            let hash = "unknown";
            try {
                const patcherHead = readFileSync(join(DIST, "patcher.js")).toString("utf8", 0, 64);
                const m = /^\/\/ Limey V1 (\S+)/.exec(patcherHead);
                if (m) hash = m[1];
            } catch { /* keep unknown */ }
            content = Buffer.from(`/* Limey ${hash} */\n` + content.toString("utf8"));
        }
        res.writeHead(200, {
            "Content-Type": name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
            "Content-Length": content.length,
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        });
        return res.end(content), true;
    }
    if (url === "/v1/install/desktop-zip") {
        const zip = buildDesktopZip();
        if (!zip) return json(res, 503, { error: "desktop build not available yet" }), true;
        res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": zip.length,
            "Content-Disposition": "attachment; filename=\"LimeyV1-Desktop.zip\"",
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        });
        res.end(zip);
        return true;
    }
    if (url === "/v1/build/status") {
        const st = key => ({
            state: buildStatus[key].state,
            built: key === "web"
                ? existsSync(join(DIST, "browser.js"))
                : existsSync(join(DIST, "patcher.js")) && existsSync(join(DIST, "renderer.js")) && existsSync(join(DIST, "preload.js")),
            ...buildStatus[key]
        });
        return json(res, 200, {
            web: st("web"),
            desktop: st("desktop"),
            building: buildStatus.web.state === "building" || buildStatus.desktop.state === "building",
            serverStartedAt: buildStatus.startedAt
        }), true;
    }
    if (url === "/v1/install/desktop") {
        const built = existsSync(join(DIST, "patcher.js")) && existsSync(join(DIST, "renderer.js")) && existsSync(join(DIST, "preload.js"));
        return json(res, 200, {
            app: "Limey V1 Discord Desktop App",
            built,
            installCommand: "pnpm build && pnpm inject",
            artifacts: built ? ["/dist/patcher.js", "/dist/renderer.js", "/dist/preload.js"] : []
        }), true;
    }
    if (url !== "/v1/install/extension") return false;
    const zip = buildExtensionZip();
    if (!zip) return json(res, 503, { error: "extension not built yet — run pnpm buildWeb" }), true;
    res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": zip.length,
        "Content-Disposition": "attachment; filename=\"LimeyV1-Extension.zip\"",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(zip);
    return true;
}

// ------------------------------------------------------------------
// Backend-provided build: if the bundles are missing at startup
// (e.g. fresh clone without a build), run `pnpm buildWeb` and/or
// `pnpm build` in-process via spawn so the server itself produces
// the browser extension and Discord Desktop App artifacts.
// ------------------------------------------------------------------
// Build status registry — lets /v1/build/status report exactly what the
// backend has done, is doing, or failed to do.
const buildStatus = {
    web: { state: "present" },   // present | building | done | failed
    desktop: { state: "present" },
    startedAt: null,
};

function startBuildIfMissing() {
    // The runtime container has no source or root node_modules — builds happen
    // in the Docker build stage. Only attempt to compile when source exists
    // (i.e. running from a repo checkout, e.g. local dev).
    const hasSource = existsSync(join(ROOT, "scripts", "build", "buildWeb.mjs"));
    if (!hasSource) {
        const missing = [
            !existsSync(join(DIST, "browser.js")) && "web",
            !existsSync(join(DIST, "patcher.js")) && "desktop",
        ].filter(Boolean);
        if (missing.length) {
            console.error(`[build] dist missing (${missing.join(", ")}) but no source available — run pnpm buildWeb / pnpm build before deploying`);
            buildStatus.web.state = existsSync(join(DIST, "browser.js")) ? "present" : "failed";
            buildStatus.desktop.state = existsSync(join(DIST, "patcher.js")) ? "present" : "failed";
        } else {
            console.log("[build] dist bundles present — skipping build");
        }
        return;
    }
    const jobs = [];
    if (!existsSync(join(DIST, "browser.js"))) {
        console.log("[build] dist/browser.js missing — running pnpm buildWeb...");
        buildStatus.web = { state: "building", startedAt: new Date().toISOString() };
        jobs.push(["web", "buildWeb", ["buildWeb"]]);
    }
    if (!existsSync(join(DIST, "patcher.js"))) {
        console.log("[build] dist/patcher.js missing — running pnpm build (Discord Desktop App)...");
        buildStatus.desktop = { state: "building", startedAt: new Date().toISOString() };
        jobs.push(["desktop", "build", ["build"]]);
    }
    if (!jobs.length) {
        console.log("[build] dist bundles present — skipping build");
        return;
    }
    buildStatus.startedAt = new Date().toISOString();
    for (const [key, name, args] of jobs) {
        const child = spawn("pnpm", args, { cwd: ROOT, stdio: "inherit" });
        child.on("error", err => {
            buildStatus[key] = { state: "failed", error: err.message, finishedAt: new Date().toISOString() };
            console.error(`[build] failed to spawn pnpm ${name}:`, err.message);
        });
        child.on("exit", code => {
            const ok = code === 0 && existsSync(join(DIST, key === "web" ? "browser.js" : "patcher.js"));
            buildStatus[key] = {
                state: ok ? "done" : "failed",
                exitCode: code,
                startedAt: buildStatus[key]?.startedAt,
                finishedAt: new Date().toISOString(),
            };
            if (ok) console.log(`[build] pnpm ${name} finished`);
            else console.error(`[build] pnpm ${name} exited with code ${code}`);
        });
    }
}

const PGKV = require("./pgkv");
const KV_ENABLED = PGKV.pgEnabled();

function kvSet(key, value) {
    if (!KV_ENABLED) return;
    void PGKV.pgSet(key, value);
}

async function kvGet(key) {
    return PGKV.pgGet(key);
}

// Hydrate the in-memory stores from PostgreSQL at startup (local files are
// only used as a fallback when DATABASE_URL is not configured).
async function hydrateKv() {
    if (!KV_ENABLED) return;
    try {
        const [usrbg, detector, reviewdbData, badges] = await Promise.all([
            kvGet("limey:usrbg"),
            kvGet("limey:detector"),
            kvGet("limey:reviewdb"),
            kvGet("limey:badges")
        ]);
        if (usrbg) usrbgData = JSON.parse(usrbg);
        if (detector) detectorData = JSON.parse(detector);
        const limeEconomyData = await kvGet("limey:lime-economy");
        if (limeEconomyData && limeEconomy) limeEconomy.hydrate(JSON.parse(limeEconomyData));
        const pluginStoreData = await kvGet("limey:plugin-store");
        if (pluginStoreData && pluginStore) pluginStore.hydrate(JSON.parse(pluginStoreData));
        if (reviewdbData && reviewdb) reviewdb.hydrate(JSON.parse(reviewdbData));
        if (badges) {
            try {
                const parsed = JSON.parse(badges);
                if (typeof parsed === "object" && !Array.isArray(parsed)) badgesData = parsed;
            } catch { }
        }
        const storedDashSessions = await kvGet("limey:dashboard-sessions");
        if (storedDashSessions) {
            try {
                const parsed = JSON.parse(storedDashSessions);
                if (typeof parsed === "object" && !Array.isArray(parsed)) dashSessions = parsed;
            } catch { }
        }
        const storedDashUsers = await kvGet("limey:dashboard-users");
        if (storedDashUsers) {
            try {
                const parsed = JSON.parse(storedDashUsers);
                if (typeof parsed === "object" && !Array.isArray(parsed)) dashUsers = parsed;
            } catch { }
        }
        console.log(`[kv] hydrated stores from PostgreSQL`);
    } catch (err) {
        console.error("[kv] failed to hydrate from Redis:", err.message);
    }
}

// ------------------------------------------------------------------
// USRBG backend — custom user banners served from this Node server
// (api/v1/usrbg/*). Data is stored in Redis (or a JSON file fallback)
// next to the server.
// ------------------------------------------------------------------
const USRBG_FILE = join(ROOT, "data", "usrbg.json");

// { userId: { url, etag, addedAt } }
let usrbgData = {};
try {
    usrbgData = JSON.parse(readFileSync(USRBG_FILE, "utf-8"));
} catch { /* empty */ }

function saveUsrbgData() {
    void kvSet("limey:usrbg", usrbgData);
    try {
        mkdirSync(join(ROOT, "data"), { recursive: true });
        writeFileSync(USRBG_FILE, JSON.stringify(usrbgData, null, 2));
    } catch (err) {
        console.error("[usrbg] failed to persist data:", err.message);
    }
}

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 1e6) { // 1 MB cap
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

function json(res, status, obj) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Discord Developer Portal endpoints
// ---------------------------------------------------------------------------

// Application Webhooks URL (Developer Portal -> Webhooks). Discord delivers
// signed event payloads (e.g. APPLICATION_AUTHORIZED, ENTITLEMENT_CREATE) and
// first an "__verification__" event whose secret must be echoed back.
// Events are signed with the same Ed25519 headers as interactions; the signing
// key is the app's Public Key (DISCORD_INTERACTIONS_PUBLIC_KEY). The echo
// secret is set via DISCORD_WEBHOOK_SECRET in the portal's Webhooks page.
function verifyDiscordSignature(req, chunks, signature, timestamp) {
    const publicKey = process.env.DISCORD_INTERACTIONS_PUBLIC_KEY || "";
    if (!publicKey || !signature || !timestamp) return false;
    const body = Buffer.concat(chunks);
    const spki = Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "hex")
    ]);
    try {
        return require("crypto").verify(
            null,
            Buffer.concat([Buffer.from(timestamp), body]),
            { key: spki, format: "der", type: "spki" },
            Buffer.from(signature, "hex")
        );
    } catch {
        return false;
    }
}

function handleDiscordWebhooks(req, res, url) {
    if (url !== "/v1/discord/webhooks") return false;
    if (req.method === "OPTIONS") return res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }).end(), true;
    if (req.method !== "POST") return json(res, 405, { error: "POST only" }), true;

    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
        if (!verifyDiscordSignature(req, chunks, signature, timestamp))
            return json(res, 401, { error: "invalid request signature" });

        try {
            const event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            console.log("[discord-webhooks] event:", event.type);

            // One-time handshake: echo the secret back exactly as received
            if (event.type === 0 && event.data && typeof event.data.webhook_secret === "string")
                return json(res, 200, { webhook_secret: event.data.webhook_secret });

            // Route known events here as they get used:
            //   APPLICATION_AUTHORIZED, ENTITLEMENT_CREATE, etc.
            return json(res, 200, { ok: true });
        } catch (e) {
            console.error("[discord-webhooks] error:", e.message);
            return json(res, 400, { error: "invalid payload" });
        }
    });
    return true;
}

// Interactions Endpoint: verifies Ed25519 signatures (public key from the
// Developer Portal, set via DISCORD_INTERACTIONS_PUBLIC_KEY) and handles PING
// so the endpoint can be registered. Real interaction handling stays with the
// gateway bot; this endpoint exists so the portal accepts the URL.
function handleDiscordInteractions(req, res, url) {
    if (url !== "/v1/discord/interactions") return false;
    if (req.method === "OPTIONS") return res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }).end(), true;
    if (req.method !== "POST") return json(res, 405, { error: "POST only" }), true;

    const publicKey = process.env.DISCORD_INTERACTIONS_PUBLIC_KEY || "";
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];

    if (!publicKey || !signature || !timestamp)
        return json(res, 401, { error: "missing signature or DISCORD_INTERACTIONS_PUBLIC_KEY not configured" }), true;

    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
        try {
            const body = Buffer.concat(chunks);
            // Discord's public key is a raw 32-byte Ed25519 key; Node's crypto
            // needs it wrapped in an SPKI structure (fixed 12-byte header).
            const spki = Buffer.concat([
                Buffer.from("302a300506032b6570032100", "hex"),
                Buffer.from(publicKey, "hex")
            ]);
            const ok = require("crypto").verify(
                null,
                Buffer.concat([Buffer.from(timestamp), body]),
                { key: spki, format: "der", type: "spki" },
                Buffer.from(signature, "hex")
            );
            if (!ok) return json(res, 401, { error: "invalid request signature" });

            const interaction = JSON.parse(body.toString("utf8") || "{}");
            // PING — required once by the portal to verify the endpoint
            if (interaction.type === 1) return json(res, 200, { type: 1 });
            // Everything else is handled by the gateway bot; ack so Discord
            // doesn't retry, without emitting any user-visible response.
            return json(res, 200, { type: 6 });
        } catch (e) {
            console.error("[discord-interactions] error:", e.message);
            return json(res, 400, { error: "invalid payload" });
        }
    });
    return true;
}

// Deep Link URL: Discord app links (e.g. from a role connection or app profile)
// land here and are bounced into the right in-app place.
function serveDeepLink(req, res) {
    const params = new URLSearchParams((req.url || "").split("?").slice(1).join("?"));
    const guildId = params.get("guild") || "1550709562267672607"; // home guild
    // The Discord app deep link scheme: discord:///CHANNEL_ID or the web fallback
    const to = params.get("to");
    if (to === "verify") {
        res.writeHead(302, { Location: "/linked-roles" });
        return res.end();
    }
    res.writeHead(302, { Location: `https://discord.com/channels/${guildId}` });
    res.end();
}

// Connection Entrypoint URL: shown on a linked role's connection card in the
// user profile. "Link account" sends the user here with an authorization_code
// (OAuth2). We bounce them into the existing dashboard Discord OAuth flow,
// which already handles code exchange at the shared callback.
function serveConnectionsEntrypoint(req, res) {
    const redirect = "https://discord.com/oauth2/authorize"
        + "?client_id=" + encodeURIComponent(process.env.DISCORD_CLIENT_ID || "1514929209158402078")
        + "&redirect_uri=" + encodeURIComponent("https://limey-discord.onrender.com/v1/oauth/callback")
        + "&response_type=code&scope=identify&state=dashboard&prompt=consent";
    res.writeHead(302, { Location: redirect });
    res.end();
}

async function handleUsrbg(req, res, url) {
    if (!url.startsWith("/v1/usrbg")) return false;

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        });
        return res.end(), true;
    }

    // Admin listing (requires token): full entries incl. image URLs
    if (req.method === "GET" && url === "/v1/usrbg/admin/users") {
        const adminToken = process.env.USRBG_ADMIN_TOKEN;
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
            return json(res, 401, { error: "unauthorized" }), true;
        }
        return json(res, 200, usrbgData), true;
    }

    // GET /v1/usrbg/users — the list consumed by the USRBG client plugin
    if (req.method === "GET" && url === "/v1/usrbg/users") {
        const users = {};
        for (const [id, entry] of Object.entries(usrbgData)) users[id] = entry.etag;
        return json(res, 200, { endpoint: "/v1/usrbg/users", users }), true;
    }

    // GET /v1/usrbg/has-banner/:id — dashboard banner check without the
    // console-noisy 404 the redirect endpoint returns for bannerless users
    const hasBannerMatch = /^\/v1\/usrbg\/has-banner\/(\d{5,25})$/.exec(url);
    if (hasBannerMatch && req.method === "GET") {
        return json(res, 200, { hasBanner: !!usrbgData[hasBannerMatch[1]] }), true;
    }

    const match = /^\/v1\/usrbg\/users\/(\d{5,25})$/.exec(url);
    if (!match) {
        if (url.startsWith("/v1/usrbg/")) return json(res, 404, { error: "not found" }), true;
        return false;
    }
    const userId = match[1];

    if (req.method === "GET") {
        const entry = usrbgData[userId];
        if (!entry) return json(res, 404, { error: "user has no banner" }), true;
        // 302 to the banner image
        res.writeHead(302, { Location: entry.url });
        return res.end(), true;
    }

    // PUT/DELETE are only allowed with the admin token (the bot uses the same
    // USRBG_ADMIN_TOKEN env var, so only it — and whoever holds the token — can write)
    const adminToken = process.env.USRBG_ADMIN_TOKEN;
    if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
        return json(res, 401, { error: "unauthorized" }), true;
    }

    if (req.method === "PUT") {
        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        const imageUrl = String(body.url || "");
        try {
            const parsed = new URL(imageUrl);
            if (!/^https?:$/.test(parsed.protocol)) throw new Error();
        } catch {
            return json(res, 400, { error: "url must be a valid http(s) image URL" }), true;
        }
        usrbgData[userId] = {
            url: imageUrl,
            etag: Date.now().toString(36),
            addedAt: new Date().toISOString()
        };
        saveUsrbgData();
        return json(res, 200, { ok: true, userId, url: imageUrl }), true;
    }

    if (req.method === "DELETE") {
        if (!usrbgData[userId]) return json(res, 404, { error: "user has no banner" }), true;
        delete usrbgData[userId];
        saveUsrbgData();
        return json(res, 200, { ok: true }), true;
    }

    return json(res, 405, { error: "method not allowed" }), true;
}

// ------------------------------------------------------------------
// Limey V1 status — the bot announces Discord rate-limit / outage events
// here (limey:status in Redis); the site banner and the client mod pick
// it up from GET /v1/status.
// ------------------------------------------------------------------
// { active, message, startedAt, updatedAt }
let limeyStatus = { active: false, message: "", startedAt: null, updatedAt: null };

async function handleStatus(req, res, url) {
    if (req.method === "GET" && url === "/v1/status") {
        return json(res, 200, limeyStatus), true;
    }

    if (req.method === "POST" && url === "/v1/status") {
        // Bot (admin token) or anyone from localhost (same container)
        const local = req.socket?.remoteAddress === "127.0.0.1" || req.socket?.remoteAddress === "::1" || req.socket?.remoteAddress === "::ffff:127.0.0.1";
        const adminToken = process.env.USRBG_ADMIN_TOKEN;
        const authorized = local || (adminToken && req.headers.authorization === `Bearer ${adminToken}`);
        if (!authorized) return json(res, 401, { error: "unauthorized" }), true;

        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        const message = String(body.message || "").slice(0, 300);
        const active = Boolean(body.active) && message.length > 0;
        limeyStatus = {
            active,
            message: active ? message : "",
            startedAt: active ? (limeyStatus.active ? limeyStatus.startedAt : new Date().toISOString()) : null,
            updatedAt: new Date().toISOString()
        };
        void kvSet("limey:status", limeyStatus);
        console.log(`[status] ${active ? "ACTIVE" : "cleared"}: ${message}`);
        return json(res, 200, { ok: true }), true;
    }

    return false;
}

// ------------------------------------------------------------------
// Limebot state — the bot's SQLite DB lives on the (ephemeral) Render
// filesystem, so every restart/deploy would wipe counting progress and
// all feature configs. The bot mirrors its feature tables into this
// Postgres-backed kv store via /v1/bot-state/... (USRBG_ADMIN_TOKEN
// auth, same token used for the other bot <-> server APIs).
// ------------------------------------------------------------------
const BOT_STATE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function handleBotState(req, res, url) {
    if (!url.startsWith("/v1/bot-state/")) return false;

    const key = decodeURIComponent(url.slice("/v1/bot-state/".length));
    if (!BOT_STATE_KEY_RE.test(key)) return json(res, 400, { error: "invalid key" }), true;
    const fullKey = `limey:bot-state:${key}`;

    if (req.method === "GET") {
        const value = await kvGet(fullKey);
        if (value == null) return json(res, 404, { error: "not found" }), true;
        try { return json(res, 200, JSON.parse(value)), true; }
        catch { return json(res, 200, value), true; }
    }

    if (req.method === "PUT") {
        const adminToken = process.env.USRBG_ADMIN_TOKEN;
        if (!adminToken || req.headers.authorization !== `Bearer ${adminToken}`) {
            return json(res, 401, { error: "unauthorized" }), true;
        }
        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        await kvSet(fullKey, body);
        return json(res, 200, { ok: true }), true;
    }

    return json(res, 405, { error: "method not allowed" }), true;
}

// ------------------------------------------------------------------
// Limey V1 Detector backend — tracks which users are running Limey V1.
// The client plugin pings every 5 min; entries expire after 30 min.
// ------------------------------------------------------------------
const DETECTOR_FILE = join(ROOT, "data", "detector.json");
const DETECTOR_TTL_MS = 30 * 60 * 1000;

// { userId: lastSeenMs }
let detectorData = {};
try {
    detectorData = JSON.parse(readFileSync(DETECTOR_FILE, "utf-8"));
} catch { /* empty */ }

let detectorSaveTimer = null;
function saveDetectorData() {
    // Debounced write so 5-minute pings don't hammer the disk/Redis
    if (detectorSaveTimer) return;
    detectorSaveTimer = setTimeout(() => {
        detectorSaveTimer = null;
        void kvSet("limey:detector", detectorData);
        try {
            mkdirSync(join(ROOT, "data"), { recursive: true });
            writeFileSync(DETECTOR_FILE, JSON.stringify(detectorData, null, 2));
        } catch (err) {
            console.error("[detector] failed to persist data:", err.message);
        }
    }, 5000);
}

function pruneDetector() {
    const cutoff = Date.now() - DETECTOR_TTL_MS;
    let changed = false;
    for (const id of Object.keys(detectorData)) {
        if (detectorData[id] < cutoff) {
            delete detectorData[id];
            changed = true;
        }
    }
    return changed;
}

// ------------------------------------------------------------------
// Donor badges — served at /badges.json for the BadgeAPI plugin.
// Shape: { [discordId]: [{ tooltip, badge }] } (badge = image URL).
// Persisted to data/badges.json, mirrored to Redis (limey:badges).
// Admin: PUT /badges.json with X-Admin-Token header to update.
// ------------------------------------------------------------------
let badgesData = {};
try {
    badgesData = JSON.parse(readFileSync(join(ROOT, "data", "badges.json"), "utf-8"));
} catch { /* fresh */ }
const BADGES_ADMIN_TOKEN = process.env.BADGES_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN || "";
let badgesSaveTimer = null;
function saveBadges() {
    if (badgesSaveTimer) return;
    badgesSaveTimer = setTimeout(() => {
        badgesSaveTimer = null;
        if (KV_ENABLED) void kvSet("limey:badges", badgesData);
        try {
            writeFileSync(join(ROOT, "data", "badges.json"), JSON.stringify(badgesData, null, 2));
        } catch (err) {
            if (!KV_ENABLED) console.error("[badges] failed to persist:", err.message);
        }
    }, 3000);
}

function handleBadges(req, res, url) {
    if (url !== "/badges.json") return false;

    if (req.method === "GET") {
        // Merge Lime tier badges (active subscribers) into the donor badges
        const merged = { ...badgesData };
        if (limeEconomy) {
            try {
                for (const [userId, badges] of Object.entries(limeEconomy.getTierBadges())) {
                    merged[userId] = [...(merged[userId] || []), ...badges];
                }
            } catch (err) {
                console.error("[badges] failed to merge lime tier badges:", err.message);
            }
        }
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=300"
        });
        res.end(JSON.stringify(merged));
        return true;
    }

    if (req.method === "PUT" && BADGES_ADMIN_TOKEN && req.headers["x-admin-token"] === BADGES_ADMIN_TOKEN) {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 5e6) req.destroy();
        });
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body || "{}");
                if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
                badgesData = parsed;
                saveBadges();
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ message: err.message }));
            }
        });
        return true;
    }

    res.writeHead(req.method === "PUT" ? 401 : 405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: req.method === "PUT" ? "admin token required" : "method not allowed" }));
    return true;
}

// ------------------------------------------------------------------
// Media proxy — fetches a remote image (gif/webp) server-side and streams it
// back with permissive CORS. Used by the GifCaptioner plugin for hosts that
// block cross-origin requests. GET /v1/media-proxy?url=<encoded url>
// ------------------------------------------------------------------
const MEDIA_PROXY_ALLOWED_HOSTS = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com|tenor\.com|giphy\.com|imgur\.com|catbox\.moe|redgifs\.com|gfycat\.com|media\.tgst\.media|imgix\.net|cloudfront\.net|githubusercontent\.com|github\.com|user-images\.githubusercontent\.com|raw\.githubusercontent\.com)$/i;

async function handleMediaProxy(req, res, url) {
    if (!url.startsWith("/v1/media-proxy")) return false;

    const origin = res.req?.headers?.origin;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return true;
    }
    if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "method not allowed" }));
        return true;
    }

    const params = new URLSearchParams(url.split("?")[1] ?? "");
    const target = params.get("url");
    let parsed;
    try {
        parsed = new URL(target ?? "");
    } catch {
        parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !MEDIA_PROXY_ALLOWED_HOSTS.test(parsed.hostname)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "invalid or disallowed url" }));
        return true;
    }

    try {
        const upstream = await fetch(parsed, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; LimeyV1MediaProxy/1.0)",
                Accept: "image/gif,image/webp,image/*,*/*;q=0.8",
                Referer: parsed.origin + "/",
            },
            redirect: "follow"
        });
        if (!upstream.ok || !upstream.body) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `upstream returned ${upstream.status}` }));
            return true;
        }

        const contentType = upstream.headers.get("content-type") || "application/octet-stream";
        if (!contentType.startsWith("image/") && !contentType.includes("octet-stream")) {
            res.writeHead(415, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: `upstream is not an image (${contentType})` }));
            return true;
        }

        res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=3600",
            ...(origin ? { "Access-Control-Allow-Origin": "*" } : {})
        });
        const reader = upstream.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
        }
        res.end();
    } catch (err) {
        console.error("[media-proxy] fetch failed:", err.message);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "upstream fetch failed" }));
        } else {
            res.end();
        }
    }
    return true;
}

// Returns true if the request was handled by the detector API
async function handleDetector(req, res, url) {
    if (!url.startsWith("/v1/detector")) return false;

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        });
        return res.end(), true;
    }

    if (req.method === "POST" && url === "/v1/detector/ping") {
        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        const userId = String(body.userId || "");
        if (!/^\d{5,25}$/.test(userId)) {
            return json(res, 400, { error: "invalid userId" }), true;
        }
        detectorData[userId] = Date.now();
        pruneDetector();
        saveDetectorData();
        const users = Object.keys(detectorData);
        return json(res, 200, { users }), true;
    }

    if (req.method === "GET" && url === "/v1/detector/users") {
        pruneDetector();
        return json(res, 200, { users: Object.keys(detectorData) }), true;
    }

    if (url.startsWith("/v1/detector/")) return json(res, 404, { error: "not found" }), true;
    return false;
}

// Persistence is now handled by PostgreSQL (pgkv.js); the Go cloud backend
// still takes a REDIS_URI for its own use.
function normalizeRedisUri(uri) {
    return uri ? uri.trim() : uri;
}

// ------------------------------------------------------------------
// ReviewDB backend (self-hosted) — mounted at /v1/reviewdb/*
// ------------------------------------------------------------------
let reviewdb;
try {
    reviewdb = require("./reviewdb-backend");
    // Let the reviewdb backend mirror its persisted database to Redis
    global.__reviewdbKvSet = kvSet;
    console.log("[reviewdb] backend loaded (postgres persistence: " + KV_ENABLED + ")");
} catch (err) {
    console.error("[reviewdb] failed to load backend:", err.message);
}

// ------------------------------------------------------------------
// Lime Economy backend — virtual currency + perk tiers, mounted at /v1/limes/*
// ------------------------------------------------------------------
let limeEconomy;
try {
    limeEconomy = require("./lime-economy-backend");
    console.log("[limes] economy backend loaded");
} catch (err) {
    console.error("[limes] failed to load backend:", err.message);
}

// ------------------------------------------------------------------
// Community Plugin Store backend — user-submitted plugins, mounted at /v1/plugins/*
// ------------------------------------------------------------------
let pluginStore;
try {
    pluginStore = require("./lime-pluginstore-backend");
    if (typeof pluginStore.attachKv === "function") pluginStore.attachKv(kvSet, kvGet);
    console.log("[pluginstore] backend loaded");
} catch (err) {
    console.error("[pluginstore] failed to load backend:", err.message);
}

// ------------------------------------------------------------------
// User dashboard — Discord OAuth login + session API (public/dashboard.html)
// Uses the shared OAuth callback (state=dashboard) and persists sessions
// via the same PostgreSQL kv store as the rest of the site.
// ------------------------------------------------------------------
const DASH_SESSIONS_KEY = "limey:dashboard-sessions";

// Hardcoded admin panel gate: only members of this guild holding this role
// may sign in to /admin (via Discord OAuth with state=admin).
const ADMIN_GUILD_ID = "1550709562267672607";
const ADMIN_ROLE_ID = "1552126541607993354";
const DISCORD_API_BASE = "https://discord.com/api/v10";

// { token: { discordId, addedAt } } + cached Discord user profiles
// hydrated from PostgreSQL in hydrateKv() when DATABASE_URL is set
let dashSessions = {};
let dashUsers = {};

function dashAvatarUrl(user) {
    if (!user) return "";
    if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
    try {
        const index = (BigInt(user.id) >> 22n) % 6n;
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    } catch {
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }
}

function dashPublicUser(user) {
    if (!user) return null;
    return { id: user.id, username: user.username, globalName: user.global_name || user.username, avatar: dashAvatarUrl(user) };
}

function dashGetSession(req) {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token || !dashSessions[token]) return null;
    return { token, discordId: dashSessions[token].discordId, admin: !!dashSessions[token].admin, user: dashUsers[dashSessions[token].discordId] || null };
}

async function dashExchangeCode(code, withGuilds) {
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
        throw Object.assign(new Error("dashboard OAuth is not configured (missing DISCORD_CLIENT_ID/SECRET)"), { status: 503 });
    }
    const body = new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://limey-discord.onrender.com/v1/oauth/callback"
    });
    const tokenRes = await fetch(DISCORD_API_BASE + "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        throw Object.assign(new Error(`Discord token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`), { status: 401 });
    }
    const { access_token, ...tokenRest } = await tokenRes.json();
    const meRes = await fetch(DISCORD_API_BASE + "/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) throw Object.assign(new Error("Discord @me failed"), { status: 401 });
    const me = await meRes.json();
    return { me, accessToken: access_token };
}

// Shared OAuth callback dispatch target: exchange the code, create a
// session, bounce back to the dashboard page with ?session=<token>.
async function handleDashboardOAuth(query, setupGuildId) {
    const code = query.get("code");
    const state = query.get("state");
    const isSetup = state === "setup";
    const isAdminLogin = state === "admin";
    const target = new URL(isAdminLogin
        ? "https://limey-discord.onrender.com/admin"
        : "https://limey-discord.onrender.com/dashboard.html");
    if (!code) {
        target.searchParams.set("login", "missing_code");
        return target.toString();
    }
    try {
        const { me, accessToken } = await dashExchangeCode(code, isSetup);
        if (withGuildsCompat(me, accessToken, isSetup)) { /* handled below */ }
        if (isAdminLogin) {
            // Hardcoded gate: caller must be a member of ADMIN_GUILD_ID with
            // ADMIN_ROLE_ID (needs the guilds.members.read scope).
            const mRes = await fetch(`${DISCORD_API_BASE}/users/@me/guilds/${ADMIN_GUILD_ID}/member`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }).catch(() => null);
            const member = mRes && mRes.ok ? await mRes.json().catch(() => null) : null;
            if (!member || !Array.isArray(member.roles) || !member.roles.includes(ADMIN_ROLE_ID)) {
                console.log(`[dashboard] admin login denied for ${me.id}`);
                target.searchParams.set("login", "forbidden");
                return target.toString();
            }
        }
        const token = require("crypto").randomBytes(32).toString("hex");
        dashSessions[token] = { discordId: me.id, addedAt: new Date().toISOString() };
        if (isAdminLogin) dashSessions[token].admin = true;
        if (me.guildIds) dashSessions[token].guildIds = me.guildIds;
        if (isSetup) {
            // remember which guild ids the user is in (from the guilds scope)
            // so the setup page can offer the right servers
            dashUsers[me.id] = Object.assign(dashUsers[me.id] || {}, me);
            dashSessions[token].guildIds = me.guildIds || [];
        }
        void kvSet(DASH_SESSIONS_KEY, dashSessions);
        void kvSet("limey:dashboard-users", dashUsers);
        target.searchParams.set("session", token);
    } catch (err) {
        console.error("[dashboard] login failed:", err.message);
        target.searchParams.set("login", "failed");
    }
    return target.toString();
}

// The guilds scope fetch used to live inside dashExchangeCode; keep the
// behaviour for setup logins without bloating the exchange helper.
async function withGuildsCompat(me, accessToken, isSetup) {
    if (!isSetup) return false;
    const gRes = await fetch(DISCORD_API_BASE + "/users/@me/guilds?with_counts=false", {
        headers: { Authorization: `Bearer ${accessToken}` }
    }).catch(() => null);
    if (gRes && gRes.ok) {
        const guilds = await gRes.json().catch(() => []);
        me.guildIds = Array.isArray(guilds) ? guilds.map(g => g.id) : [];
    }
    return true;
}

// Dashboard session API: GET /v1/dashboard/me, POST /v1/dashboard/logout
async function handleDashboard(req, res, url) {
    // Admin-panel session API lives under /v1/admin (handled here too)
    const isAdminRoute = url.startsWith("/v1/admin/");
    if (!url.startsWith("/v1/dashboard") && !isAdminRoute) return false;

    // Session-authenticated proxy for the per-guild verification setup API
    // (limebot /v1/verify/guild/*). We verify the caller has an active
    // dashboard session and append ?userId= so the bot can attribute the
    // change. Guild membership/permission checks happen in the bot (which
    // sees the live member list).
    if (url.startsWith("/v1/dashboard/verify-guild/")) {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const sub = url.slice("/v1/dashboard/verify-guild/".length);
        const guildId = sub.split("/")[0];
        if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
        if (req.method === "OPTIONS") return res.end(), true;
        const sep = url.includes("?") ? "&" : "?";
        const upstreamUrl = "/v1/verify/guild/" + sub + sep + "userId=" + session.discordId;
        proxyLimebot(req, res, upstreamUrl);
        return true;
    }

    // Counting setup proxy: /v1/dashboard/counting-guild/:guildId -> limebot /v1/counting/guild/:guildId
    if (url.startsWith("/v1/dashboard/counting-guild/")) {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const sub = url.slice("/v1/dashboard/counting-guild/".length);
        const guildId = sub.split("/")[0];
        if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
        if (req.method === "OPTIONS") return res.end(), true;
        const sep = url.includes("?") ? "&" : "?";
        const upstreamUrl = "/v1/counting/guild/" + sub + sep + "userId=" + session.discordId;
        proxyLimebot(req, res, upstreamUrl);
        return true;
    }

    // Welcomer setup proxy: /v1/dashboard/welcomer-guild/:guildId -> limebot /v1/welcomer/guild/:guildId
    if (url.startsWith("/v1/dashboard/welcomer-guild/")) {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const sub = url.slice("/v1/dashboard/welcomer-guild/".length);
        const guildId = sub.split("/")[0];
        if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
        if (req.method === "OPTIONS") return res.end(), true;
        const sep = url.includes("?") ? "&" : "?";
        const upstreamUrl = "/v1/welcomer/guild/" + sub + sep + "userId=" + session.discordId;
        proxyLimebot(req, res, upstreamUrl);
        return true;
    }

    // Leveling setup proxy: /v1/dashboard/leveling-guild/:guildId -> limebot /v1/leveling/guild/:guildId
    if (url.startsWith("/v1/dashboard/leveling-guild/")) {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const sub = url.slice("/v1/dashboard/leveling-guild/".length);
        const guildId = sub.split("/")[0];
        if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
        if (req.method === "OPTIONS") return res.end(), true;
        const sep = url.includes("?") ? "&" : "?";
        const upstreamUrl = "/v1/leveling/guild/" + sub + sep + "userId=" + session.discordId;
        proxyLimebot(req, res, upstreamUrl);
        return true;
    }

    // Generic feature-setup proxies (same model as counting/welcomer/leveling):
    // /v1/dashboard/<feature>-guild/:guildId -> limebot /v1/<feature>/guild/:guildId
    for (const feature of ["autoroles", "reaction-roles", "starboard", "suggestions"]) {
        if (url.startsWith(`/v1/dashboard/${feature}-guild/`)) {
            const session = dashGetSession(req);
            if (!session) return json(res, 401, { error: "not logged in" }), true;
            const sub = url.slice(`/v1/dashboard/${feature}-guild/`.length);
            const guildId = sub.split("/")[0];
            if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
            if (req.method === "OPTIONS") return res.end(), true;
            const sep = url.includes("?") ? "&" : "?";
            const upstreamUrl = `/v1/${feature}/guild/` + sub + sep + "userId=" + session.discordId;
            proxyLimebot(req, res, upstreamUrl);
            return true;
        }
    }

    // Rules editor: /v1/dashboard/verify-rules/:guildId[?] -> /v1/verify/guild/:guildId/rules
    if (url.startsWith("/v1/dashboard/verify-rules/")) {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const sub = url.slice("/v1/dashboard/verify-rules/".length);
        const guildId = sub.split("/")[0];
        if (!/^\d{17,20}$/.test(guildId)) return json(res, 400, { error: "invalid guild id" }), true;
        const sep = url.includes("?") ? "&" : "?";
        const upstreamUrl = "/v1/verify/guild/" + sub + "/rules" + sep + "userId=" + session.discordId;
        proxyLimebot(req, res, upstreamUrl);
        return true;
    }

    if (url === "/v1/dashboard/my-guilds" && req.method === "GET") {
        const session = dashGetSession(req);
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        // The session recorded the user's guild ids at login (guilds scope).
        // The bot filters to servers it shares where the user can manage.
        try {
            const ids = (session.guildIds || []).join(",");
            proxyLimebot(req, res, "/v1/verify/my-guilds?userId=" + session.discordId + "&ids=" + encodeURIComponent(ids));
            return true;
        } catch (e) {
            return json(res, 500, { error: "guild list failed" }), true;
        }
    }

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        });
        return res.end(), true;
    }

    const session = dashGetSession(req);

    if (url === "/v1/dashboard/me" && req.method === "GET") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;

        // Enrich the basic session with live status from the rest of the stack
        const discordId = session.discordId;
        const [verified, limes] = await Promise.all([
            // verification status comes from the limebot (proxied below)
            new Promise(resolve => {
                const upReq = http.request({ host: "127.0.0.1", port: 8152, path: `/v1/verify/status/${discordId}`, method: "GET", timeout: 4000 }, up => {
                    let data = "";
                    up.on("data", c => data += c);
                    up.on("end", () => {
                        try { resolve(JSON.parse(data).verified === true); } catch { resolve(null); }
                    });
                });
                upReq.on("error", () => resolve(null));
                upReq.on("timeout", () => { upReq.destroy(); resolve(null); });
                upReq.end();
            }),
            // limes wallet from the economy backend
            new Promise(async resolve => {
                try {
                    const wallet = await (limeEconomy?.getWalletFor
                        ? limeEconomy.getWalletFor(discordId)
                        : Promise.resolve(null));
                    resolve(wallet);
                } catch { resolve(null); }
            })
        ]);

        return json(res, 200, {
            user: dashPublicUser(session.user),
            loggedInAt: dashSessions[session.token].addedAt,
            verified,
            limes: limes ? {
                balance: limes.balance,
                streak: limes.streak,
                tier: limes.tier,
                multiplier: limes.multiplier,
                nextDailyAt: limes.nextDailyAt
            } : null,
            // site feature status
            build: {
                web: buildStatus.web.state,
                desktop: buildStatus.desktop.state,
                built: existsSync(join(DIST, "browser.js"))
            },
            cloudSync: cloudUp
        }), true;
    }

    // Claim the daily Limes from the dashboard (proxied to the economy backend
    // with the session's verified Discord id — no client-supplied userId)
    // Proxy a call into the lime economy backend on behalf of the logged-in
    // dashboard user. The economy backend reads the body via stream events, so
    // we feed it a minimal event-emitting stub request (never a plain object —
    // that would never fire "end" and the handler would hang).
    async function economyProxy(path, bodyObj, headers = {}) {
        const fakeReq = Object.assign(new (require("events").EventEmitter)(), {
            method: bodyObj === undefined ? "GET" : "POST",
            headers: { "x-limey-user-id": session?.discordId, ...headers },
            socket: req.socket
        });
        Promise.resolve().then(() => {
            if (bodyObj !== undefined) fakeReq.emit("data", Buffer.from(JSON.stringify(bodyObj)));
            fakeReq.emit("end");
        });
        let status = 500, payload = { error: "request failed" };
        const fakeRes = {
            writeHead: (s) => { status = s; },
            end: (body) => { try { payload = JSON.parse(body); } catch { /* keep default */ } }
        };
        try {
            await limeEconomy.handle(fakeReq, fakeRes, path);
        } catch (err) {
            console.error(`[dashboard] economyProxy ${path} threw:`, err.stack || err.message || err);
            return { status: 500, payload: { error: "economy backend error" } };
        }
        return { status, payload };
    }

    if (!limeEconomy) return json(res, 503, { error: "economy backend unavailable" }), true;

    // Claim the daily Limes from the dashboard (proxied with the session's
    // verified Discord id — no client-supplied userId)
    if (url === "/v1/dashboard/daily" && req.method === "POST") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        try {
            const { status, payload } = await economyProxy("/v1/limes/earn/daily", {});
            if (status >= 500) console.error("[dashboard] daily claim upstream failure:", JSON.stringify(payload));
            return json(res, status, payload), true;
        } catch (err) {
            console.error("[dashboard] daily claim crashed:", err.stack || err.message || err);
            return json(res, 500, { error: "daily claim failed" }), true;
        }
    }

    // Wallet transaction history (proxied)
    if (url === "/v1/dashboard/history" && req.method === "GET") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        const { status, payload } = await economyProxy("/v1/limes/history?userId=" + session.discordId);
        return json(res, status, payload), true;
    }

    // Redeem a donation code (proxied)
    if (url === "/v1/dashboard/redeem" && req.method === "POST") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* ignore */ }
        const { status, payload } = await economyProxy("/v1/limes/donation-codes/redeem", { code: body.code });
        return json(res, status, payload), true;
    }

    // Admin-panel session API (Discord OAuth + hardcoded guild/role gate).
    // GET /v1/admin/me -> session info when the caller holds an admin session.
    if (url === "/v1/admin/me" && req.method === "GET") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        return json(res, 200, {
            user: dashPublicUser(adminSession.user),
            discordId: adminSession.discordId
        }), true;
    }

    // POST /v1/admin/limes/donation-codes — the admin page's code generator,
    // authorized by the admin Discord session instead of a shared token.
    if (url === "/v1/admin/limes/donation-codes" && req.method === "POST") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* ignore */ }
        const { status, payload } = await economyProxy("/v1/limes/admin/donation-codes", { limes: body.limes, tier: body.tier, count: body.count }, {
            "x-admin-token": process.env.LIMES_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN || ""
        });
        return json(res, status, payload), true;
    }

    // USRBG manager — same operations as the token-guarded /v1/usrbg/*
    // endpoints, but authorized by the admin Discord session instead of
    // the shared USRBG_ADMIN_TOKEN (so /admin needs no extra token).
    if (url.startsWith("/v1/admin/usrbg")) {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;

        if (url === "/v1/admin/usrbg/users" && req.method === "GET")
            return json(res, 200, usrbgData), true;

        const m = /^\/v1\/admin\/usrbg\/users\/(\d{5,25})$/.exec(url);
        if (m && req.method === "PUT") {
            let body;
            try { body = JSON.parse((await readBody(req)) || "{}"); } catch {
                return json(res, 400, { error: "invalid JSON body" }), true;
            }
            const imageUrl = String(body.url || "");
            try {
                const parsed = new URL(imageUrl);
                if (!/^https?:$/.test(parsed.protocol)) throw new Error();
            } catch {
                return json(res, 400, { error: "url must be a valid http(s) image URL" }), true;
            }
            usrbgData[m[1]] = {
                url: imageUrl,
                etag: Date.now().toString(36),
                addedAt: new Date().toISOString()
            };
            saveUsrbgData();
            return json(res, 200, { ok: true, userId: m[1], url: imageUrl }), true;
        }
        if (m && req.method === "DELETE") {
            if (!usrbgData[m[1]]) return json(res, 404, { error: "user has no banner" }), true;
            delete usrbgData[m[1]];
            saveUsrbgData();
            return json(res, 200, { ok: true }), true;
        }
        return json(res, 404, { error: "not found" }), true;
    }

    if (url === "/v1/dashboard/logout" && req.method === "POST") {
        if (session) {
            delete dashSessions[session.token];
            void kvSet(DASH_SESSIONS_KEY, dashSessions);
        }
        return json(res, 200, { ok: true }), true;
    }

    // Public tiers list — handled here because it lives under /v1/dashboard
    // and would otherwise be swallowed by the catch-all below.
    if (url === "/v1/dashboard/tiers" && req.method === "GET") {
        if (!limeEconomy) return json(res, 503, { error: "economy backend unavailable" }), true;
        let status = 500, body = JSON.stringify({ tiers: [] });
        await limeEconomy.handle({ method: "GET", headers: {}, socket: req.socket }, {
            writeHead: s => { status = s; },
            end: b => { body = b; }
        }, "/v1/limes/tiers");
        return json(res, status, JSON.parse(body)), true;
    }

    if (url.startsWith("/v1/dashboard")) return json(res, 404, { error: "not found" }), true;
    return false;
}

// ------------------------------------------------------------------
// LimeyCloud backend (Go) — settings sync API at /v1/*
// ------------------------------------------------------------------
let cloudUp = false;

function startCloud() {
    if (!existsSync(CLOUD_BIN)) {
        console.log("[cloud] backend binary not found — settings sync disabled (see cloud/README)");
        return;
    }

    const child = spawn(CLOUD_BIN, {
        env: {
            ...process.env,
            HOST: CLOUD_HOST,
            PORT: String(CLOUD_PORT),
            // Only hand the backend a Redis URI if one is actually configured;
            // a fake local fallback makes kv.Open fatally fail in prod where
            // no Redis runs alongside the app.
            REDIS_URI: normalizeRedisUri(process.env.REDIS_URI) || (process.env.DATABASE_URL ? "" : "127.0.0.1:6379"),
            ROOT_REDIRECT: process.env.ROOT_REDIRECT || "https://limey-discord.onrender.com",
            DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI || "https://limey-discord.onrender.com/v1/oauth/callback",
            PEPPER_SETTINGS: process.env.PEPPER_SETTINGS || "limeycloud-settings-pepper",
            PEPPER_SECRETS: process.env.PEPPER_SECRETS || "limeycloud-secrets-pepper",
            SIZE_LIMIT: process.env.SIZE_LIMIT || "100000",
        },
        stdio: "inherit"
    });

    child.on("error", err => console.error("[cloud] failed to start:", err.message));
    child.on("exit", code => {
        cloudUp = false;
        if (code !== null) console.error(`[cloud] backend exited with code ${code}`);
        // Respawn with backoff so a crash doesn't disable settings sync
        // until the next deploy.
        if (!startCloud.stopping) {
            startCloud.backoff = Math.min((startCloud.backoff || 1000) * 2, 30000);
            console.error(`[cloud] restarting backend in ${startCloud.backoff}ms`);
            setTimeout(startCloud, startCloud.backoff);
        }
    });

    // The Go server prints nothing on ready; probe until it answers.
    let tries = 0;
    const probe = setInterval(() => {
        const req = http.get({ host: CLOUD_HOST, port: CLOUD_PORT, path: "/v1", timeout: 1000 }, res => {
            res.resume();
            if (!cloudUp) console.log(`[cloud] backend ready at http://${CLOUD_HOST}:${CLOUD_PORT}`);
            cloudUp = true;
            clearInterval(probe);
        });
        req.on("error", () => {
            if (++tries >= 15) {
                console.error("[cloud] backend did not become ready (is Redis running? set REDIS_URI)");
                clearInterval(probe);
            }
        });
    }, 1000);
}

function proxyLimebot(req, res, overridePath) {
    const opts = {
        host: "127.0.0.1",
        port: 8152,
        path: overridePath || req.url,
        method: req.method,
        headers: { ...req.headers, host: "127.0.0.1:8152" }
    };
    const upstream = http.request(opts, upRes => {
        // A caller bug must never take the whole server down (double-write
        // used to throw ERR_HTTP_HEADERS_SENT and crash the process).
        try {
            if (res.headersSent) return upRes.destroy();
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.pipe(res);
        } catch (e) {
            console.error("[proxy] limebot response error:", e.message);
            upRes.destroy();
        }
    });
    upstream.on("error", () => {
        try {
            if (!res.headersSent) json(res, 503, { error: "verification service unavailable" });
            else res.end();
        } catch { /* socket already gone */ }
    });
    req.pipe(upstream);
}

function proxyCloud(req, res, overridePath) {
    if (!cloudUp) return send(res, 503, "Cloud backend unavailable");

    const opts = {
        host: CLOUD_HOST,
        port: CLOUD_PORT,
        path: overridePath || req.url,
        method: req.method,
        headers: { ...req.headers, host: `${CLOUD_HOST}:${CLOUD_PORT}` }
    };

    const upstream = http.request(opts, upRes => {
        try {
            if (res.headersSent) return upRes.destroy();
            res.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.pipe(res);
        } catch (e) {
            console.error("[proxy] cloud response error:", e.message);
            upRes.destroy();
        }
    });
    upstream.on("error", () => {
        try {
            if (!res.headersSent) send(res, 502, "Cloud backend error");
            else res.end();
        } catch { /* socket already gone */ }
    });
    req.pipe(upstream);
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".zip": "application/zip"
};

// Force browsers to download the userscript instead of trying to render it
const DOWNLOAD_TYPES = new Set([".user.js", ".zip"]);

function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
}

// Serve a themed error page for browser-facing errors (falls back to plain text)
function sendErrorPage(res, status) {
    const page = join(PUBLIC, `${status}.html`);
    if (!existsSync(page)) {
        return send(res, status, status === 403 ? "Forbidden" : status === 404 ? "Not found" : "Internal server error");
    }
    serveFile(res, page, status);
}

function serveFile(res, filePath, status = 200) {
    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";

    const headers = { "Content-Type": type };
    if (DOWNLOAD_TYPES.has(ext)) {
        headers["Content-Disposition"] = `attachment; filename="${filePath.split(/[\\/]/).pop()}"`;
    }
    if (ext === ".map" || filePath.includes(`${DIST}`)) {
        // build artifacts are immutable per version, cache them for a day
        headers["Cache-Control"] = "public, max-age=86400";
    }

    try {
        const stream = createReadStream(filePath);
        stream.on("open", () => {
            res.writeHead(status, headers);
            stream.pipe(res);
        });
        stream.on("error", () => send(res, 500, "Internal server error"));
    } catch {
        send(res, 500, "Internal server error");
    }
}

// Named static pages served at clean URLs
const NAMED_PAGES = {
    "/docs": "docs/index.html",
    "/plugins": "plugins.html",
    "/download": "download.html",
    "/install": "install.html",
    "/limes": "limes.html",
    "/dashboard": "dashboard.html",
    "/submit-plugin": "submit-plugin.html",
    "/code": "code.html",
    "/404": "404.html",
    "/terms": "terms.html",
    "/terms-of-service": "terms.html",
    "/privacy": "privacy.html",
    "/privacy-policy": "privacy.html",
};

function serveNamedPage(res, url) {
    // Accept optional trailing slash (/plugins/)
    const page = NAMED_PAGES[url] || NAMED_PAGES[url.replace(/\/+$/, "") || url];
    if (!page) return false;
    serveFile(res, join(PUBLIC, page));
    return true;
}

// Admin page — sign-in is gated by the Discord OAuth admin role check
// (state=admin callback), so the page is always available.
function serveAdminPage(res, url) {
    if (url !== "/admin" && url !== "/admin/") return false;
    const page = join(PUBLIC, "admin.html");
    if (!existsSync(page)) return send(res, 404, "Not found"), true;
    serveFile(res, page);
    return true;
}

const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);

    // Discord Developer Portal fields:
    //   Interactions Endpoint URL      -> /v1/discord/interactions
    //   Webhooks URL (Developer Portal)
    //                                  -> /v1/discord/webhooks
    //   Linked Roles Verification URL  -> /linked-roles
    //   Terms of Service URL           -> /terms
    //   Privacy Policy URL             -> /privacy
    //   Deep Link URL                  -> /deep-link
    //   Connection Entrypoint URL      -> /connections/entrypoint
    if (handleDiscordInteractions(req, res, url)) return;
    if (handleDiscordWebhooks(req, res, url)) return;
    if (url === "/linked-roles") return serveFile(res, join(PUBLIC, "verify.html")), true;
    if (url === "/deep-link") return serveDeepLink(req, res), true;
    if (url === "/connections/entrypoint") return serveConnectionsEntrypoint(req, res), true;

    // Named pages (plugins, download, install, 404, verify)
    if (url === "/verify") return serveFile(res, join(PUBLIC, "verify.html")), true;
    if (url === "/favicon.ico") {
        const ico = join(ROOT, "browser", "icon.png");
        if (existsSync(ico)) return serveFile(res, ico), true;
    }
    if (serveNamedPage(res, url)) return;

    // Proxy the verification API to the limebot fastify server (port 8152)
    if (url.startsWith("/v1/verify/")) return proxyLimebot(req, res);

    // Donor badges JSON for the BadgeAPI plugin
    if (handleBadges(req, res, url)) return;

    // /install/desktop — themed desktop install page (API variant lives at /v1/install/desktop)
    if (url === "/install/desktop") return serveFile(res, join(PUBLIC, "install.html"));

    // Admin panel page
    if (serveAdminPage(res, url)) return;

    // Proxy /v1/* to the LimeyCloud (Go) backend
    // Shared OAuth callback for all Limey V1 Discord OAuth flows.
    // Dispatches by the `state` query param to the owning backend:
    //   state=settings-sync -> Go cloud backend /v1/oauth/callback
    //   state=reviewdb      -> self-hosted reviewdb auth
    //   state=limes         -> lime economy site login
    // NOTE: uses raw req.url — `url` above has the query string stripped.
    if ((req.url || "").split("?")[0] === "/v1/oauth/callback") {
        const query = (req.url || "").split("?").slice(1).join("?");
        const params = new URLSearchParams(query);
        if (params.get("state") === "reviewdb" && reviewdb) {
            if (await reviewdb.handle(req, res, "/v1/reviewdb/auth" + (query ? "?" + query : ""))) return;
        }
        if (params.get("state") === "limes" && limeEconomy) {
            // Exchange the code server-side and bounce the session to the site page
            if (await limeEconomy.handle(req, res, "/v1/limes/callback" + (query ? "?" + query : ""))) return;
        }
        if (params.get("state") === "dashboard" || params.get("state") === "setup" || params.get("state") === "admin") {
            // Dashboard login (optionally from the server-verification setup
            // section, or the admin panel): exchange the code and redirect
            // with a session token. The setup flow additionally carries the
            // guilds scope so the bot can list servers to configure. The
            // admin flow additionally requires the hardcoded admin role.
            const dest = await handleDashboardOAuth(params, params.get("state") === "setup" ? params.get("guild_id") : null);
            res.writeHead(302, { Location: dest });
            return res.end();
        }
        // state=verify: the Go backend returns { userId } for the verify flow,
        // but ONLY the bot's own origin is allowed to call it with that state.
        // Hand the exchange to the limebot, which owns the verify role.
        if (params.get("state") === "verify" || params.get("clientMod") === "verify") {
            const clean = new URLSearchParams(params);
            return proxyLimebot(req, Object.assign(res, {}), "/v1/verify/oauth/callback" + (clean.toString() ? "?" + clean.toString() : ""));
        }
        if (params.get("state") === "setup") {
            const clean = new URLSearchParams(params);
            const dest = await handleDashboardOAuth(clean, params.get("guild_id"));
            res.writeHead(302, { Location: dest });
            return res.end();
        }
        // default: settings sync cloud (Go backend owns this route);
        // strip our client-side state so the Go callback sees a clean request
        params.delete("state");
        const cleanQuery = params.toString();
        return proxyCloud(req, res, "/v1/oauth/callback" + (cleanQuery ? "?" + cleanQuery : ""));
    }

    if (url === "/v1" || url.startsWith("/v1/")) {
        // Community plugin store (handled in-process)
        if (pluginStore && url.startsWith("/v1/plugins/") && await pluginStore.handle(req, res, url)) return;
        if (await handleStatus(req, res, url)) return;
        if (await handleBotState(req, res, url)) return;
        // USRBG API lives alongside /v1 (handled in-process)
        if (await handleUsrbg(req, res, url)) return;
        // Limey V1 Detector API (handled in-process)
        if (await handleDetector(req, res, url)) return;
        // CORS-friendly media proxy for the GifCaptioner plugin
        if (await handleMediaProxy(req, res, url)) return;
        // User dashboard session API (handled in-process)
        if (await handleDashboard(req, res, url)) return;
        // Backend-provided install: freshly packaged extension zip + desktop install info
        if (handleInstall(req, res, url)) return;
        // Self-hosted ReviewDB API
        if (reviewdb && url.startsWith("/v1/reviewdb/") && await reviewdb.handle(req, res, url)) return;
        // Lime Economy (virtual currency + perk tiers)
        if (limeEconomy && url.startsWith("/v1/limes/") && await limeEconomy.handle(req, res, url)) return;
        return proxyCloud(req, res);
    }

    // Monaco editor bundle for the /code playground (built by buildWeb into dist/vendor/monaco)
    if (url.startsWith("/vendor/monaco/")) {
        const rel = normalize(url.slice("/vendor/monaco/".length)).replace(/^(\.\.[\/\\])+/, "");
        const filePath = resolve(join(DIST, "vendor", "monaco"), rel);
        if (!filePath.startsWith(join(DIST, "vendor", "monaco"))) return sendErrorPage(res, 403);
        if (existsSync(filePath) && statSync(filePath).isFile()) return serveFile(res, filePath);
        return sendErrorPage(res, 404);
    }

    // Serve dist/ files under /dist/*
    if (url.startsWith("/dist/")) {
        const rel = normalize(url.slice("/dist/".length)).replace(/^(\.\.[\/\\])+/, "");
        const filePath = resolve(DIST, rel);
        if (!filePath.startsWith(DIST)) return sendErrorPage(res, 403);
        if (existsSync(filePath) && statSync(filePath).isFile()) return serveFile(res, filePath);
        return sendErrorPage(res, 404);
    }

    // Serve static assets from public/
    let rel = normalize(url).replace(/^(\.\.[\/\\])+/, "").replace(/^[/\\]+/, "");
    let filePath = resolve(PUBLIC, rel);

    if (!filePath.startsWith(PUBLIC)) return sendErrorPage(res, 403);

    if (!existsSync(filePath)) {
        // Themed 404 page (this replaces the old SPA fallback to index.html)
        return sendErrorPage(res, 404);
    } else if (statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
    }

    if (!existsSync(filePath)) return sendErrorPage(res, 404);
    serveFile(res, filePath);
});

// ------------------------------------------------------------------
// Limebot (Discord bot, limebot/) — optional, enabled when LIMEBOT_TOKEN is set
// ------------------------------------------------------------------
// Validate the limebot proxy (if configured) by GETting Discord's REST root
// through it. Logs the result; does not block startup.
async function checkLimebotProxy() {
    const proxyUrl = process.env.LIMEBOT_PROXY;
    if (!proxyUrl) {
        console.log("[limebot] LIMEBOT_PROXY not set — bot will use direct Discord API access");
        return;
    }
    if (!/^(https?|socks[45h?]):\/\/[^\s]+$/i.test(proxyUrl)) {
        console.error("[limebot] LIMEBOT_PROXY is set but not a valid http(s)/socks5 URL — ignoring");
        return;
    }
    try {
        const started = Date.now();
        if (/^socks/i.test(proxyUrl)) {
            const { SocksProxyAgent } = await import("socks-proxy-agent");
            const https = await import("node:https");
            await new Promise((resolve, reject) => {
                const req = https.get("https://discord.com/api/v10/gateway", { agent: new SocksProxyAgent(proxyUrl), timeout: 10_000 }, res => {
                    res.resume();
                    res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`));
                });
                req.on("timeout", () => req.destroy(new Error("timeout")));
                req.on("error", reject);
            });
        } else {
            const { ProxyAgent } = await import("undici");
            const res = await fetch("https://discord.com/api/v10/gateway", {
                dispatcher: new ProxyAgent(proxyUrl),
                signal: AbortSignal.timeout(10_000)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        console.log(`[limebot] proxy check OK (${Date.now() - started}ms): ${proxyUrl.replace(/\/\/[^@/]*@/, "//***@")}`);
    } catch (err) {
        console.error(`[limebot] proxy check FAILED: ${err.message} — the bot may still try to use it and fail`);
    }
}

function startLimebot() {
    if (!process.env.LIMEBOT_TOKEN) {
        console.log("[limebot] LIMEBOT_TOKEN not set — bot disabled");
        return;
    }
    if (!existsSync(join(ROOT, "limebot", "dist", "index.js"))) {
        console.log("[limebot] dist/index.js not found — bot disabled (was it built?)");
        return;
    }

    void checkLimebotProxy();

    const child = spawn(process.execPath, ["--enable-source-maps", "."], {
        cwd: join(ROOT, "limebot"),
        env: { ...process.env, LIMEBOT: "1", LIMEBOT_ADMIN_TOKEN: process.env.USRBG_ADMIN_TOKEN },
        stdio: "inherit"
    });
    child.on("error", err => console.error("[limebot] failed to start:", err.message));
    child.on("exit", code => {
        if (code !== null) console.error(`[limebot] exited with code ${code}`);
        // Respawn with backoff so a crash doesn't disable verification until
        // the next deploy.
        if (!startLimebot.stopping) {
            startLimebot.backoff = Math.min((startLimebot.backoff || 1000) * 2, 30000);
            console.error(`[limebot] restarting in ${startLimebot.backoff}ms`);
            setTimeout(startLimebot, startLimebot.backoff);
        }
    });
}    startBuildIfMissing();
    startCloud();
    startLimebot();

// Wait for PostgreSQL hydration (if configured) before accepting requests
hydrateKv().then(() => {
    return kvGet("limey:status");
}).then(stored => {
    if (stored) {
        try { limeyStatus = JSON.parse(stored); } catch { /* ignore */ }
    }
}).finally(() => {
    server.listen(PORT, HOST, () => {
        console.log(`Limey V1 web server running at http://${HOST}:${PORT} (persistent storage: ${KV_ENABLED ? "PostgreSQL" : "local files"})`);
    });
});

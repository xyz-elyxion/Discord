/*
 * Limey V1 — static hosting server
 * Serves the website (public/) and build artifacts (dist/) with plain Node.js.
 * No external dependencies required.
 */

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const { createHmac, createHash } = require("crypto");
const { inflateRawSync, inflateSync } = require("zlib");
const { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("fs");
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
const SENTINEL_SECRET = process.env.SENTINEL_SECRET || process.env.KEY;
const EXTENSION_ZIP_PATH = join(DIST, "LimeyV1-Extension.zip");

// ---------------------------------------------------------------------------
// Build-file signing key lifecycle
//
// The signing key must be stable across reboots (files signed yesterday must
// still verify tomorrow, and clients embed the *public* value at build time).
// Resolution order:
//   1. First boot: BUILD_SIGNING_KEY set in env → use it and persist a
//      fingerprint to the database (pgkv, key "limey:build-signing-key").
//   2. Later boots: if the DB has no stored key, use env again.
//   3. If env is unset but the DB has a stored key, keep signing with the
//      fingerprint from the DB (env rotation without downtime stays possible
//      by setting a new BUILD_SIGNING_KEY and clearing the DB key).
// The stored value is a SHA-256 fingerprint, never the raw key, so leaking
// the kv row doesn't leak the signing material itself.
// ---------------------------------------------------------------------------
const SIGNING_KV_KEY_FINGERPRINT = "limey:build-signing-key";
let SIGNING_KEY = process.env.BUILD_SIGNING_KEY || SENTINEL_SECRET || null;

async function initSigningKey() {
    const fingerprint = SIGNING_KEY
        ? createHash("sha256").update(SIGNING_KEY).digest("hex")
        : null;

    const stored = await kvGet(SIGNING_KV_KEY_FINGERPRINT);

    if (stored) {
        // A key is already recorded; verify continuity rather than overwriting.
        // pgGet returns the parsed JSONB value (a plain fingerprint string).
        const storedFingerprint = typeof stored === "string" ? stored.replace(/"/g, "") : stored;
        if (fingerprint && storedFingerprint !== fingerprint) {
            console.warn(
                `[signing] BUILD_SIGNING_KEY changed since the database recorded the previous one.\n` +
                `[signing] Old fingerprint: ${storedFingerprint}\n` +
                `[signing] New fingerprint: ${fingerprint}\n` +
                `[signing] Continuing with the new env key and updating the DB record.\n` +
                `[signing] REMINDER: clients built with the OLD key will reject new files — republish BUILD_SIGNING_KEY_PUB for client builds.`
            );
        }
        await kvSet(SIGNING_KV_KEY_FINGERPRINT, fingerprint);
        return;
    }

    // Nothing stored yet: this is the first boot with signing active — record
    // the fingerprint so future boots can detect key rotation.
    if (fingerprint) {
        await kvSet(SIGNING_KV_KEY_FINGERPRINT, fingerprint);
        console.log("[signing] persisted signing-key fingerprint to the database");
    } else {
        console.log("[signing] no BUILD_SIGNING_KEY configured; files are served unsigned");
    }
}



// [zip entry, source path] — manifest.json and the shell live at the zip root
// so the unzipped folder can be loaded directly via "Load unpacked".
const EXTENSION_FILES = [
    ["manifest.json", "browser/manifest.json"],
    ["manifestv2.json", "browser/manifestv2.json"],
    ["background.js", "browser/background.js"],
    ["content.js", "browser/content.js"],
    ["service-worker.js", "browser/service-worker.js"],
    ["GMPolyfill.js", "browser/GMPolyfill.js"],
    ["patch-worker.js", "browser/patch-worker.js"],
    ["modifyResponseHeaders.json", "browser/modifyResponseHeaders.json"],
    ["icon.png", "browser/icon.png"],
    ["dist/browser.js", "dist/browser.js"],
    ["dist/browser.css", "dist/browser.css"],
];
const EXTENSION_VENDOR_FILES = [["vendor/monaco/index.js", "dist/vendor/monaco/index.js"]];

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
    for (const [entry, path] of files) {
        try {
            zipData[entry] = new Uint8Array(readFileSync(join(ROOT, path)));
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

// Ready-built Limey V1 Desktop standalone app payload (built by the Docker
// `desktop` stage): esbuild bundles in dist/, views/native helpers in
// static/ and package.json at the root. Teammates run it with any desktop
// Electron: unzip, `npm install`, `npm exec electron .` — no Discord patching
// involved. Formal installers (.exe/.dmg/AppImage) are published by the repo's
// GitHub release workflow on tags.
const DESKTOP_APP_DIR = join(DIST, "limeyDesktop");

let desktopAppZipCache = null;
let desktopAppZipKey = "";

// Payload location: in the production image the `desktop` Docker stage output
// is copied to dist/limeyDesktop. When that copy is absent (dev/sandbox
// servers, where dist/ is not synced), fall back to packaging straight from
// the limey-v1-desktop checkout — its layout (dist/ + static/ +
// package.json) is identical to the copied one.
const DESKTOP_APP_SOURCES = [
    join(DIST, "limeyDesktop"),
    join(ROOT, "limey-v1-desktop"),
];

function desktopAppDir() {
    for (const dir of DESKTOP_APP_SOURCES) {
        if (existsSync(join(dir, "dist", "js", "main.js"))) return dir;
    }
    return null;
}

function desktopAppBuilt() {
    return desktopAppDir() !== null;
}

// Packaged installers produced by the `desktop` Docker stage (or a local
// `pnpm exec electron-builder` run in the checkout fallback): Linux
// AppImage/.tar.gz and the portable Windows .zip. Served one by one so users
// don't have to pull the full bundle zip for a ready-to-run build.
// Path separators AND hyphens (artifact names carry "Limey V1 Desktop-x.y.z")
// must both be in the class; hyphen stays last so it stays a literal.
const DESKTOP_APP_INSTALLER_RE = /^[\w /.-]+\.(AppImage|deb|tar\.gz|zip)$/;

// Collect from EVERY built source (runtime copy and checkout alike): the two
// layouts can be out of sync with each other, and whichever one carries the
// newest packaged artifacts should win. URLs use the BASENAME only — slashes
// in the path segment get re-interpreted by proxies, breaking the download.
function desktopAppInstallers() {
    const seen = new Map();
    for (const source of DESKTOP_APP_SOURCES) {
        if (!existsSync(join(source, "dist", "js", "main.js"))) continue;
        const distDir = join(source, "dist");
        if (!existsSync(distDir)) continue;

        for (const { full, rel } of collectDesktopAppFiles([], distDir, "dist")) {
            if (!DESKTOP_APP_INSTALLER_RE.test(rel) || !statSync(full).isFile()) continue;
            const base = rel.slice(rel.lastIndexOf("/") + 1);
            if (!seen.has(base)) seen.set(base, { base, full });
        }
    }
    return [...seen.values()];
}

function collectDesktopAppFiles(acc, dir, prefix = "") {
    for (const name of readdirSync(dir)) {
        // The checkout fallback lives next to node_modules and this project's
        // own .git — never ship those in the payload.
        if (name === "node_modules" || name === ".git") continue;
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (statSync(full).isDirectory()) collectDesktopAppFiles(acc, full, rel);
        else acc.push({ full, rel });
    }
    return acc;
}

function buildDesktopAppZip() {
    const base = desktopAppDir();
    if (!base) return null;

    let zipSync;
    try { ({ zipSync } = require("fflate")); } catch { return null; }

    const files = collectDesktopAppFiles([], base);
    const key = files.map(f => statSync(f.full).mtimeMs).join(",");
    if (desktopAppZipCache && key === desktopAppZipKey) return desktopAppZipCache;

    const zipData = {};
    for (const { full, rel } of files) {
        try {
            zipData["LimeyV1Desktop/" + rel] = new Uint8Array(readFileSync(full));
        } catch { /* skip unreadable files */ }
    }
    zipData["LimeyV1Desktop/RUN_INSTRUCTIONS.txt"] = new TextEncoder().encode(
        "Limey V1 Desktop — standalone Discord client (Electron)\n\n" +
        "1. Unzip this folder.\n" +
        "2. Inside the folder run:  npm install\n" +
        "3. Start the app with:     npm exec electron .\n\n" +
        "The app never patches your Discord install; it loads the Limey V1 mod\n" +
        "fresh from the Limey backend on first launch. Build from source or get\n" +
        "packaged releases: https://github.com/xyz-elyxion/Discord/releases\n"
    );
    const zipped = Buffer.from(zipSync(zipData, { level: 9 }));
    desktopAppZipCache = zipped;
    desktopAppZipKey = key;
    return zipped;
}

function handleInstall(req, res, url) {
    // Serve the desktop build files to the Go installer, stamped with the
    // build hash (first line of patcher.js: "// Limey V1 <hash>") so the
    // installer can detect installed vs latest.
    //
    // Every JS file is additionally wrapped in an HMAC signature trailer so
    // clients can verify the files came from this backend and were not
    // substituted (e.g. a self-built "standalone" bundle posing as official).
    // The signature is server-authoritative: only holders of the backend's
    // signing key can produce it, so a self-built copy can't masquerade as an
    // official one when tools check it.
    // Release channel support: "stable" serves the current dist files.
    // Channel snapshots live in dist/<channel>/, frozen by
    // scripts/publishChannel.mjs:
    //   lts — frozen stable snapshot; falls back to the current stable
    //         files with their hash until the first pin is published, so
    //         the channel works from day one.
    //   rc / beta / canary / alpha — pre-release snapshots of the NEXT
    //         version (freshest first: alpha → canary → beta → rc); unlike
    //         LTS they must never be silently replaced by stable files
    //         (stable is older than a pre-release), so an unpublished
    //         channel answers 503 with a clear error instead.
    const CH_FILES = "(lts|rc|beta|canary|alpha|nightly|edge|debug|custom|snapshot|experimental|early|insider|preview-ch|dev-preview|internal|community)";
    const chMatch = new RegExp("^/v1/install/files/" + CH_FILES + "/([\\w.-]+\\.(?:js|css))$").exec(url);
    if (chMatch) {
        const channel = chMatch[1];
        const name = chMatch[2];
        const snapshotDir = join(DIST, channel);
        const pinned = existsSync(join(snapshotDir, "patcher.js"));
        if (!pinned && channel !== "lts") {
            return json(res, 503, { error: channel + " build not published yet — pre-release snapshots are frozen per release cycle/batch" }), true;
        }
        const dir = pinned ? snapshotDir : DIST;
        const filePath = join(dir, name);
        if (!existsSync(filePath)) return json(res, 404, { error: "file not found — is the build ready?" }), true;

        let content = readFileSync(filePath);
        let hash = null;
        try {
            const patcherHead = readFileSync(join(dir, "patcher.js")).toString("utf8", 0, 64);
            const m = /^\/\/ Limey V1 (\S+)/.exec(patcherHead);
            if (m) hash = m[1];
        } catch { /* keep null */ }
        if (name.endsWith(".css")) {
            // The installer fetches renderer.css only to read the hash comment.
            content = Buffer.from(`/* Limey ${hash ?? "unknown"} */\n` + content.toString("utf8"));
            // Stamp format must stay exactly "/* Limey <hash> */" — installers
            // and updaters parse the hash from this first line.
        } else if (hash && SIGNING_KEY) {
            content = Buffer.concat([
                content,
                Buffer.from(`/*!sig:${createHmac("sha256", SIGNING_KEY).update(content).digest("hex")}*/`)
            ]);
        }
        res.writeHead(200, {
            "Content-Type": name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8",
            "Content-Length": content.length,
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        });
        return res.end(content), true;
    }
    if (url.startsWith("/v1/install/files/")) {
        const name = url.slice("/v1/install/files/".length);
        if (!/^[\w.-]+\.(js|css)$/.test(name)) return json(res, 400, { error: "invalid file name" }), true;
        const filePath = join(DIST, name);
        if (!existsSync(filePath)) return json(res, 404, { error: "file not found — is the build ready?" }), true;

        let content = readFileSync(filePath);
        let hash = null;
        try {
            const patcherHead = readFileSync(join(DIST, "patcher.js")).toString("utf8", 0, 64);
            const m = /^\/\/ Limey V1 (\S+)/.exec(patcherHead);
            if (m) hash = m[1];
        } catch { /* keep null */ }
        if (name.endsWith(".css")) {
            // The installer fetches renderer.css only to read the hash comment.
            content = Buffer.from(`/* Limey ${hash ?? "unknown"} */\n` + content.toString("utf8"));
        } else if (hash && SIGNING_KEY) {
            // Sign: HMAC-SHA256 over file contents, key-bound, public verifiable.
            // Trained clients/installers extract the trailing `/*!sig:<hex>*/`
            // and re-check it against the body.
            content = Buffer.concat([
                content,
                Buffer.from(`/*!sig:${createHmac("sha256", SIGNING_KEY).update(content).digest("hex")}*/`)
            ]);
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
    if (url === "/v1/install/desktop-app") {
        const built = desktopAppBuilt();
        return json(res, 200, {
            app: "Limey V1 Desktop",
            description: "Standalone Discord client (Vesktop fork) with the Limey V1 mod preloaded",
            built,
            zip: "/v1/install/desktop-app-zip",
            // Ready-to-run packaged builds (AppImage / tar.gz / Windows zip),
            // streamed from DON local disk (the `desktop` Docker stage output).
            installers: desktopAppInstallers().map(f => ({
                name: f.base,
                size: statSync(f.full).size,
                // installer names contain spaces — keep URLs encoded
                url: `/v1/install/desktop-app/installers/${encodeURIComponent(f.base)}`
            })),
            artifacts: built ? [
                "/dist/limeyDesktop/dist/js/main.js",
                "/dist/limeyDesktop/dist/js/preload.js",
                "/dist/limeyDesktop/dist/js/renderer.js",
                "/dist/limeyDesktop/dist/js/renderer.css"
            ] : []
        }), true;
    }

    // Installer names carry spaces, which arrive percent-encoded in the URL —
    // the match must tolerate %20 and decode before filename comparison;
    // names are re-validated against the strict regex after decoding.
    const desktopAppInstaller = /^\/v1\/install\/desktop-app\/installers\/([\w %-.]+\.(?:AppImage|deb|tar\.gz|zip))$/.exec(url);
    if (desktopAppInstaller) {
        // Installer names carry spaces, which arrive percent-encoded — decode
        // before matching; desktopAppInstallers() only ever returns whitelisted
        // artifact basenames, so lookup by basename is safe.
        const name = decodeURIComponent(desktopAppInstaller[1]);
        const file = desktopAppInstallers().find(f => f.base === name);
        if (!file) return json(res, 404, { error: "installer not found — is the desktop build ready?" }), true;
        // Stream directly — these run 100MB+, no buffering through json/serve.
        res.writeHead(200, {
            "Content-Type": name.endsWith(".zip") ? "application/zip" : name.includes(".tar.gz") ? "application/gzip" : "application/octet-stream",
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*"
        });
        createReadStream(file.full).pipe(res);
        return true;
    }

    if (url === "/v1/install/desktop-app-zip") {
        const zip = buildDesktopAppZip();
        if (!zip) return json(res, 503, { error: "desktop app build not available yet" }), true;
        res.writeHead(200, {
            "Content-Type": "application/zip",
            "Content-Length": zip.length,
            "Content-Disposition": "attachment; filename=\"LimeyV1Desktop-app.zip\"",
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

        // Channel-aware install surface: the /v1/channels registry distilled
        // to what a downloader/installer needs. `branch` mirrors the
        // installer's --branch value (installer/cli.go): the host channel
        // "discord-development" maps to branch "development".
        let channels;
        if (releaseChannels) {
            channels = {
                schema: releaseChannels.CURRENT_SCHEMA,
                currentTrack: "stable", // installer/updater-served builds are standalone -> stable
                // true once a frozen LTS snapshot exists in dist/lts/; until
                // then --channel lts installs track the current stable build.
                ltsAvailable: existsSync(join(DIST, "lts", "patcher.js")),
                // Publish state per snapshot channel (scripts/publishChannel.mjs):
                // lts falls back to stable when unpinned; rc/beta answer 503.
                published: Object.fromEntries(SNAPSHOT_CHANNELS.map(ch => [ch, existsSync(join(DIST, ch, "patcher.js"))])),
                docs: "https://limey-discord.onrender.com/docs/release-channels",
                installTargets: releaseChannels.CHANNELS
                    // Desktop hosts only — the web channel installs via the
                    // browser extension, not the installer.
                    .filter(ch => ch.category === "host" && ch.implemented && /^discord-/.test(ch.id))
                    .map(ch => ({
                        channel: ch.id,
                        name: ch.name,
                        // "discord-development" -> "development": installer --branch value
                        branch: ch.id.replace(/^discord-/, ""),
                        description: ch.description
                    }))
            };
        }
        return json(res, 200, {
            app: "Limey V1 Discord Desktop App",
            built,
            installCommand: "pnpm build && pnpm inject",
            artifacts: built ? ["/dist/patcher.js", "/dist/renderer.js", "/dist/preload.js"] : [],
            ...(channels ? { channels } : {})
        }), true;
    }
    if (url !== "/v1/install/extension") return false;
    let zip = buildExtensionZip();
    if (!zip && existsSync(EXTENSION_ZIP_PATH)) {
        // dist/browser.js is missing here (partial deploy/build), but the image
        // ships a zip built during the Docker build stage — serve that instead
        // of failing the install outright.
        try {
            if (statSync(EXTENSION_ZIP_PATH).size > 0) {
                zip = new Uint8Array(readFileSync(EXTENSION_ZIP_PATH));
                console.warn("[install] dist/browser.js missing — serving the prebuilt packaged zip from disk");
            }
        } catch { /* unreadable zip — fall through to the 503 */ }
    }
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
        const bans = await kvGet("limey:bans");
        if (bans) {
            try {
                const parsed = JSON.parse(bans);
                if (typeof parsed === "object" && !Array.isArray(parsed)) bansData = parsed;
            } catch { }
        }
        try {
            const geocache = await kvGet("limey:geocache");
            if (geocache) for (const [ip, v] of Object.entries(JSON.parse(geocache))) geoCache.set(ip, v);
        } catch { /* best effort */ }
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
            // The JSONB column round-trips objects directly; stored string
            // values (legacy rows, other writers) are parsed as a fallback.
            const parsed = typeof storedDashSessions === "string"
                ? (() => { try { return JSON.parse(storedDashSessions); } catch { return null; } })()
                : storedDashSessions;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) dashSessions = parsed;
        }
        const storedDashUsers = await kvGet("limey:dashboard-users");
        if (storedDashUsers) {
            // The JSONB column round-trips objects directly; stored string
            // values (legacy rows, other writers) are parsed as a fallback.
            // (Same dual-shape handling the sessions block above uses.)
            const parsed = typeof storedDashUsers === "string"
                ? (() => { try { return JSON.parse(storedDashUsers); } catch { return null; } })()
                : storedDashUsers;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) dashUsers = parsed;
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

// --
// Limey V1 bans — admin panel curates the list; Limey V1 clients check it at
// boot and keep the mod inert while their user id is on it.
// { userId: { reason, bannedAt, by } }
// ------------------------------------------------------------------
const BANS_FILE = join(ROOT, "data", "bans.json");

let bansData = {};
try {
    bansData = JSON.parse(readFileSync(BANS_FILE, "utf-8"));
    if (typeof bansData !== "object" || Array.isArray(bansData)) bansData = {};
} catch { /* starts empty */ }

function saveBans() {
    void kvSet("limey:bans", bansData);
    try {
        mkdirSync(join(ROOT, "data"), { recursive: true });
        writeFileSync(BANS_FILE, JSON.stringify(bansData, null, 2));
    } catch (err) {
        console.error("[bans] failed to persist data:", err.message);
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
// Tools lookup proxy — powers the Tools page (invite + server lookup)
// ---------------------------------------------------------------------------
// Discord's REST API does not send CORS headers to arbitrary websites, so the
// Tools page resolves lookups through the site. Only unauthenticated public
// endpoints are hit — no bot token involved. Responses are cached for 2 min to
// stay inside the unauthenticated rate limit.

const LookupTtlMs = 120_000;
const lookupCache = new Map(); // key -> { at, status, body }

function lookupCacheGet(key) {
    const hit = lookupCache.get(key);
    if (hit) {
        if (Date.now() - hit.at < LookupTtlMs) return hit;
        lookupCache.delete(key);
    }
    return null;
}

async function handleToolsLookup(req, res, url) {
    if (!url.startsWith("/v1/tools/lookup/")) return false;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return true;
    }
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }), true;

    const rest = url.slice("/v1/tools/lookup/".length).split("?")[0];
    const inviteMatch = rest.match(/^invite\/([a-zA-Z0-9-]{2,32})$/);
    const guildMatch = rest.match(/^guild\/(\d{10,25})$/);
    if (!inviteMatch && !guildMatch) return json(res, 404, { error: "unknown lookup" }), true;

    const cached = lookupCacheGet(rest);
    if (cached) return json(res, cached.status, cached.body), true;

    // Invite resolution gives guild name, member/online counts and channel info.
    // Guild widget.json only works when the guild enabled the widget; the client
    // falls back to snowflake-only info when it doesn't.
    const target = inviteMatch
        ? `invites/${inviteMatch[1]}?with_counts=true&with_expiration=true`
        : `guilds/${guildMatch[1]}/widget.json`;

    try {
        const upstream = await fetch(new URL(target, "https://discord.com/api/v10/"), {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; LimeyV1Tools/1.0)",
                Accept: "application/json",
            },
            redirect: "follow",
        });
        let body;
        try {
            body = await upstream.json();
        } catch {
            body = null;
        }
        if (!body || typeof body !== "object") {
            return json(res, 502, { error: "unexpected upstream response" }), true;
        }
        lookupCache.set(rest, { at: Date.now(), status: upstream.status, body });
        json(res, upstream.status, body);
        return true;
    } catch (err) {
        console.error("[tools-lookup]", rest, err?.message || err);
        return json(res, 502, { error: "lookup failed" }), true;
    }
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
// The client plugin pings every 60s; entries expire after 5 min.
// Each entry stores { t: lastSeenMs, cc: ISO country code or null }.
// The country is derived from the pinger's IP (coarse, country-level
// only) via ipwho.is and cached so each IP is looked up once.
// ------------------------------------------------------------------
const DETECTOR_FILE = join(ROOT, "data", "detector.json");
const DETECTOR_TTL_MS = 5 * 60 * 1000;

// { userId: { t, cc } } (legacy entries may be plain numbers)
let detectorData = {};
try {
    detectorData = JSON.parse(readFileSync(DETECTOR_FILE, "utf-8"));
} catch { /* empty */ }

// { ip: { cc, ts } } — country lookups are cached for 30 days
const geoCache = new Map();
try {
    for (const [ip, v] of Object.entries(JSON.parse(readFileSync(join(ROOT, "data", "geocache.json"), "utf-8")))) {
        geoCache.set(ip, v);
    }
} catch { /* empty */ }

let geoSaveTimer = null;
function saveGeoCache() {
    if (geoSaveTimer) return;
    geoSaveTimer = setTimeout(() => {
        geoSaveTimer = null;
        void kvSet("limey:geocache", Object.fromEntries(geoCache));
        try {
            mkdirSync(join(ROOT, "data"), { recursive: true });
            writeFileSync(join(ROOT, "data", "geocache.json"), JSON.stringify(Object.fromEntries(geoCache)));
        } catch { /* best effort */ }
    }, 5000);
}

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:|localhost$)/i;

async function lookupCountry(ip) {
    if (!ip || PRIVATE_IP_RE.test(ip)) return null;
    const cached = geoCache.get(ip);
    if (cached && Date.now() - cached.ts < 30 * 24 * 3600 * 1000) return cached.cc ?? null;
    try {
        const r = await fetch("https://ipwho.is/" + ip, { signal: AbortSignal.timeout(5000) });
        const j = await r.json();
        const cc = (j && j.success !== false && typeof j.country_code === "string" && j.country_code.length === 2)
            ? j.country_code.toUpperCase()
            : null;
        geoCache.set(ip, { cc, ts: Date.now() });
        saveGeoCache();
        return cc;
    } catch {
        return cached ? cached.cc ?? null : null;
    }
}

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
        const t = typeof detectorData[id] === "object" ? detectorData[id].t : detectorData[id];
        if (t < cutoff) {
            delete detectorData[id];
            changed = true;
        }
    }
    return changed;
}

function detectorCountries() {
    const countries = {};
    for (const v of Object.values(detectorData)) {
        const cc = typeof v === "object" ? v.cc : null;
        if (cc) countries[cc] = (countries[cc] || 0) + 1;
    }
    return countries;
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
        const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
            || req.socket?.remoteAddress || "";
        const cc = await lookupCountry(ip);
        detectorData[userId] = { t: Date.now(), cc };
        pruneDetector();
        saveDetectorData();
        const users = Object.keys(detectorData);
        return json(res, 200, { users, countries: detectorCountries() }), true;
    }

    if (req.method === "GET" && url === "/v1/detector/users") {
        pruneDetector();
        return json(res, 200, { users: Object.keys(detectorData), countries: detectorCountries() }), true;
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
// Limey V1 Release Channels — channel manifest for updaters, SDKs and
// the settings UI, mounted at /v1/channels (static registry data; the
// two implemented tracks are stable + dev, everything else is a
// proposed definition, never an artifact URL).
// ------------------------------------------------------------------
let releaseChannels;
try {
    releaseChannels = require("./release-channels");
    console.log("[channels] release-channel manifest loaded (" + releaseChannels.CHANNELS.length + " channels, schema " + releaseChannels.CURRENT_SCHEMA + ")");
} catch (err) {
    console.error("[channels] failed to load backend:", err.message);
}

// ------------------------------------------------------------------
// Limey Sentinel — self-hosted proof-of-work captcha (ALTCHA Sentinel
// inspired), mounted at /v1/sentinel/*. Free, no third-party service.
// ------------------------------------------------------------------
let sentinel;
try {
    sentinel = require("./sentinel-backend");
    console.log("[sentinel] backend loaded (pow captcha: " + (process.env.SENTINEL_SECRET ? "env secret" : "process key") + ")");
} catch (err) {
    console.error("[sentinel] failed to load backend:", err.message);
}

// ------------------------------------------------------------------
// Community Plugin Store backend — user-submitted plugins, mounted at /v1/plugins/*
// ------------------------------------------------------------------
let pluginStore;
try {
    pluginStore = require("./lime-pluginstore-backend");
    if (typeof pluginStore.attachKv === "function") pluginStore.attachKv(kvSet, kvGet);
    if (sentinel && typeof pluginStore.attachSentinel === "function") pluginStore.attachSentinel(sentinel.verifyPayload);
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

// Release channels the admin panel can freeze into / the live-rollout
// strategy values the updater accepts ("stable" until an admin flips it —
// matches release-channels.js implemented track ids).
const SNAPSHOT_CHANNELS = ["lts", "rc", "beta", "canary", "alpha", "nightly", "edge", "debug", "custom", "snapshot", "experimental", "early", "insider", "preview-ch", "dev-preview", "internal", "community"];
const LIVE_CHANNELS = ["stable", "lts"];
const LIVE_CHANNEL_KEY = "limey:live-release-channel";

// Channel publish state must survive container restarts: the frozen files in
// dist/<channel>/ live on ephemeral disk, so every publish/unpublish is also
// recorded here (PostgreSQL KV + a local JSON file fallback). On startup
// restoreChannelSnapshots() re-copies the recorded snapshot files back into
// dist/ so /v1/install/files/<channel>/* keep answering after a redeploy.
const CHANNEL_STATE_KEY = "limey:channel-snapshots";
const CHANNEL_STATE_FILE = join(ROOT, "data", "channel-snapshots.json");
const CH_FILES_LIST = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
// { [channel]: { hash, publishedAt, files: { [file]: base64 } } } — in-memory
// mirror of the persisted publish state.
let channelState = {};
try {
    channelState = JSON.parse(readFileSync(CHANNEL_STATE_FILE, "utf8"));
    if (typeof channelState !== "object" || Array.isArray(channelState)) channelState = {};
} catch { /* starts empty */ }

function saveChannelState() {
    void kvSet(CHANNEL_STATE_KEY, channelState);
    try {
        mkdirSync(join(ROOT, "data"), { recursive: true });
        writeFileSync(CHANNEL_STATE_FILE, JSON.stringify(channelState, null, 2));
    } catch (err) {
        console.error("[channels] failed to persist publish state:", err.message);
    }
}

function recordChannelPublish(channel, hash) {
    channelState[channel] = { hash: hash ?? null, publishedAt: new Date().toISOString() };
    saveChannelState();
}

function recordChannelUnpublish(channel) {
    delete channelState[channel];
    saveChannelState();
}

// Re-materialize recorded snapshots after a restart: copy the stored files
// from KV (if present) into dist/<channel>/, or re-freeze from the current
// stable dist files when the disk copy survived but only the db row is back.
// Falls back gracefully when the recorded hash no longer matches dist.
async function restoreChannelSnapshots() {
    if (KV_ENABLED) {
        try {
            const stored = await kvGet(CHANNEL_STATE_KEY);
            if (stored) {
                const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) channelState = parsed;
            }
        } catch { /* keep file-loaded state */ }
        if (Object.keys(channelState).length) {
            try {
                mkdirSync(join(ROOT, "data"), { recursive: true });
                writeFileSync(CHANNEL_STATE_FILE, JSON.stringify(channelState, null, 2));
            } catch { /* best-effort mirror */ }
        }
    }
    for (const [channel, entry] of Object.entries(channelState)) {
        if (!SNAPSHOT_CHANNELS.includes(channel)) continue;
        const snapshotDir = join(DIST, channel);
        const alreadyHere = existsSync(join(snapshotDir, "patcher.js"));
        if (alreadyHere) {
            console.log(`[channels] channel ${channel} snapshot already on disk (hash ${entry.hash ?? "unknown"})`);
            continue;
        }
        // Re-freeze from the stored base64 copies when the KV row carries
        // them (the normal restart path); otherwise copy from stable dist.
        let restored = false;
        if (entry.files && typeof entry.files === "object") {
            try {
                mkdirSync(snapshotDir, { recursive: true });
                for (const file of CH_FILES_LIST) {
                    const b64 = entry.files[file];
                    if (!b64) continue;
                    writeFileSync(join(snapshotDir, file), Buffer.from(b64, "base64"));
                }
                restored = existsSync(join(snapshotDir, "patcher.js"));
            } catch (err) {
                console.error(`[channels] failed to restore ${channel} from stored copies:`, err.message);
            }
        }
        if (!restored) {
            const stableReady = CH_FILES_LIST.every(f => existsSync(join(DIST, f)));
            if (!stableReady) {
                console.warn(`[channels] channel ${channel} recorded as published but dist is not ready — snapshot not restored`);
                continue;
            }
            try {
                mkdirSync(snapshotDir, { recursive: true });
                for (const file of CH_FILES_LIST) copyFileSync(join(DIST, file), join(snapshotDir, file));
                restored = true;
            } catch (err) {
                console.error(`[channels] failed to restore ${channel} from dist:`, err.message);
            }
        }
        if (restored) console.log(`[channels] restored channel ${channel} snapshot (hash ${entry.hash ?? "unknown"}) after restart`);
    }
}

function captureChannelFiles(channel) {
    const files = {};
    for (const file of CH_FILES_LIST) {
        try {
            files[file] = readFileSync(join(DIST, file)).toString("base64");
        } catch { /* missing dist file — caller already validated */ }
    }
    return files;
}

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

    // Limey Sentinel gate: Limes actions require a fresh POW solve so bots
    // can't farm the daily claim or brute-force donation codes.
    async function sentinelGate(bodyObj) {
        if (!sentinel) return { ok: true };
        const payload = bodyObj?.sentinel;
        if (typeof payload !== "string") return { ok: false, error: "Human check required — reload the page and try again.", status: 403 };
        const result = sentinel.verifyPayload(payload, { consume: true });
        if (!result.ok) return { ok: false, error: "Human check failed — reload the page and try again." + (result.error ? ` (${result.error})` : ""), status: 403 };
        return { ok: true };
    }
    // Cheap GET so dashboard.html can promise a puzzle exists before rendering
    // the widget (also surfaces "sentinel down" as an explicit 503).
    if (url === "/v1/dashboard/challenge" && req.method === "GET") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        if (!sentinel) return json(res, 503, { error: "sentinel unavailable" }), true;
        // proxy the real challenge issuer so difficulty-tiering logic applies
        return sentinel.handle(
            { method: "GET", headers: req.headers, socket: req.socket },
            res,
            "/v1/sentinel/challenge"
        ), true;
    }

    // Claim the daily Limes from the dashboard (proxied with the session's
    // verified Discord id — no client-supplied userId)
    if (url === "/v1/dashboard/daily" && req.method === "POST") {
        if (!session) return json(res, 401, { error: "not logged in" }), true;
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* ignore */ }
        const gate = await sentinelGate(body);
        if (!gate.ok) return json(res, gate.status || 403, { error: gate.error, code: "sentinel_required" }), true;
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
        const gate = await sentinelGate(body);
        if (!gate.ok) return json(res, gate.status || 403, { error: gate.error, code: "sentinel_required" }), true;
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

    // ------------------------------------------------------------------
    // Limey V1 bans — admin-session management (public /v1/bans/check is
    // handled in the main request handler above).
    // ------------------------------------------------------------------
    if (url === "/v1/admin/bans" && req.method === "GET") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        return json(res, 200, bansData), true;
    }

    if (url === "/v1/admin/bans" && req.method === "POST") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        const userId = String(body.userId || "").trim();
        if (!/^\d{5,25}$/.test(userId)) return json(res, 400, { error: "userId must be a numeric Discord user id" }), true;
        bansData[userId] = {
            reason: String(body.reason || "").slice(0, 500),
            bannedAt: Date.now(),
            by: adminSession.discordId
        };
        saveBans();
        return json(res, 200, { userId, ...bansData[userId] }), true;
    }

    const bansDeleteMatch = /^\/v1\/admin\/bans\/(\d{5,25})$/.exec(url);
    if (bansDeleteMatch && req.method === "DELETE") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        if (!bansData[bansDeleteMatch[1]]) return json(res, 404, { error: "user is not banned" }), true;
        delete bansData[bansDeleteMatch[1]];
        saveBans();
        return json(res, 200, { unbanned: bansDeleteMatch[1] }), true;
    }

    const toolsMatch = /^\/v1\/admin\/tools\/user\/(\d{5,25})$/.exec(url);
    if (toolsMatch && req.method === "GET") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        const userId = toolsMatch[1];
        const ban = bansData[userId] || null;
        const banner = usrbgData[userId] || null;
        const cloud = await readUserCloudSettings(userId);
        // getWalletFor() would create a zero wallet for unknown users — only
        // report Limes when the user actually has one.
        const hasWallet = !!limeEconomy?._db?.()?.wallets?.[userId];
        const wallet = hasWallet ? limeEconomy.getWalletFor(userId) : null;
        console.log(`[admin] support view: ${adminSession.discordId} opened user ${userId} (${cloud?.found ? "cloud ok" : "no cloud"})`);
        return json(res, 200, {
            userId,
            ban: ban ? { reason: ban.reason || "", bannedAt: ban.bannedAt ?? null, by: ban.by || null } : null,
            usrbg: banner ? { url: banner.url, addedAt: banner.addedAt || null } : null,
            cloud: cloud || null,
            limes: wallet || null
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

    // ------------------------------------------------------------------
    // Admin release-channel manager — freeze the built dist artifacts into
    // a snapshot channel, unpublish, and choose the live rollout channel.
    // ------------------------------------------------------------------
    if (url === "/v1/admin/channels" && req.method === "GET") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        if (!releaseChannels) return json(res, 503, { error: "channel registry unavailable" }), true;
        const snapshotChannels = ["lts", "rc", "beta", "canary", "alpha"];
        const strategy = await kvGet(LIVE_CHANNEL_KEY);
        const hashes = {};
        for (const ch of snapshotChannels) {
            try {
                const head = readFileSync(join(DIST, ch, "patcher.js"), "utf8").slice(0, 64);
                hashes[ch] = /^\/\/ Limey V1 (\S+)/.exec(head)?.[1] ?? null;
            } catch { hashes[ch] = null; }
        }
        const head = readFileSync(join(DIST, "patcher.js"), "utf8").slice(0, 64);
        const stableHash = /^\/\/ Limey V1 (\S+)/.exec(head)?.[1] ?? null;
        return json(res, 200, {
            schema: releaseChannels.CURRENT_SCHEMA,
            stableHash,
            liveChannel: typeof strategy === "string" && LIVE_CHANNELS.includes(strategy) ? strategy : "stable",
            strategy: releaseChannels.manifest().strategy,
            published: Object.fromEntries(snapshotChannels.map(ch => [ch, existsSync(join(DIST, ch, "patcher.js"))])),
            snapshots: Object.fromEntries(snapshotChannels.map(ch => [ch, { hash: hashes[ch], publishedAt: channelState[ch]?.publishedAt ?? null }]))
        }), true;
    }

    const chPublish = new RegExp(`^\\/v1\\/admin\\/channels\\/(${SNAPSHOT_CHANNELS.join("|")})\\/publish$`).exec(url);
    if (chPublish && req.method === "POST") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        const channel = chPublish[1];
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch { /* optional force flag */ }
        const force = body?.force === true;
        const snapshotDir = join(DIST, channel);
        const files = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
        for (const file of files) {
            if (existsSync(join(DIST, file))) continue;
            return json(res, 503, { error: "dist artifacts missing — is the container build ready?" }), true;
        }
        const hashOf = dir => {
            try {
                const head = readFileSync(join(dir, "patcher.js"), "utf8").slice(0, 64);
                return (/^\/\/ Limey V1 (\S+)/.exec(head) || [])[1] ?? null;
            } catch { return null; }
        };
        const targetHash = hashOf(DIST);
        const existingHash = hashOf(snapshotDir);
        // Refuse accidental re-pointing of a live snapshot without --force.
        if (existingHash && !force) {
            return json(res, 409, {
                error: `snapshot already frozen (hash ${existingHash ?? "unknown"}) — send {"force":true} to re-point`,
                currentHash: existingHash
            }), true;
        }
        mkdirSync(snapshotDir, { recursive: true });
        for (const file of files) copyFileSync(join(DIST, file), join(snapshotDir, file));
        // Persist the publish state so a container restart can rebuild the
        // snapshot from the recorded copies instead of dropping the channel.
        recordChannelPublish(channel, targetHash);
        channelState[channel].files = captureChannelFiles(channel);
        saveChannelState();
        console.log(`[admin] ${adminSession.discordId} froze release channel ${channel} at hash ${targetHash ?? "unknown"}${force ? " (forced)" : ""}`);
        return json(res, 200, { ok: true, channel, hash: targetHash, forced: Boolean(force) }), true;
    }

    const chUnpublish = new RegExp(`^\\/v1\\/admin\\/channels\\/(${SNAPSHOT_CHANNELS.join("|")})$`).exec(url);
    if (chUnpublish && req.method === "DELETE") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401, { error: "not authorized" }), true;
        const channel = chUnpublish[1];
        if (!existsSync(join(DIST, channel, "patcher.js"))) return json(res, 404, { error: `channel ${channel} has no snapshot` }), true;
        for (const file of ["patcher.js", "preload.js", "renderer.js", "renderer.css"]) {
            try { rmSync(join(DIST, channel, file), { force: true }); } catch { /* best-effort */ }
        }
        recordChannelUnpublish(channel);
        console.log(`[admin] ${adminSession.discordId} unpublished release channel ${channel}`);
        return json(res, 200, { ok: true, channel }), true;
    }

    if (url === "/v1/admin/channels/strategy" && req.method === "POST") {
        const adminSession = dashGetSession(req);
        if (!adminSession || !adminSession.admin) return json(res, 401), true;
        let body = {};
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch {
            return json(res, 400, { error: "invalid JSON body" }), true;
        }
        const liveChannel = String(body.liveChannel || "stable");
        if (!LIVE_CHANNELS.includes(liveChannel)) {
            return json(res, 400, { error: "liveChannel must be one of " + LIVE_CHANNELS.join("|") }), true;
        }
        await kvSet(LIVE_CHANNEL_KEY, liveChannel);
        console.log(`[admin] ${adminSession.discordId} set live rollout channel to ${liveChannel}`);
        return json(res, 200, { ok: true, liveChannel }), true;
    }

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
    ".avif": "image/avif",
    ".jfif": "image/jpeg",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
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
    // Data files fetched cross-origin by clients (plugin catalog, badges, etc.)
    if (ext === ".json") {
        headers["Access-Control-Allow-Origin"] = "*";
    }
    // The Bot SDK is imported by URL from other bots/dev environments, including
    // browser-side ESM imports, which are CORS-checked — allow any origin.
    if (filePath.includes(`${PUBLIC}\\sdk\\`) || filePath.includes(`${PUBLIC}/sdk/`)) {
        headers["Access-Control-Allow-Origin"] = "*";
    }
    if (DOWNLOAD_TYPES.has(ext)) {
        headers["Content-Disposition"] = `attachment; filename="${filePath.split(/[\\/]/).pop()}"`;
    }
    if (ext === ".map" || filePath.includes(`${DIST}`)) {
        // build artifacts are immutable per version, cache them for a day
        headers["Cache-Control"] = "public, max-age=86400";
    }
    // Installer binaries are the one thing that MUST track the current
    // container: when we patch a crash (e.g. the imgui "assert Size > 0"),
    // a rebuilt container has to be able to hand out fresh bytes within
    // minutes, not a day later. Give just these a short window; the rest of
    // dist/ (renderer/patcher files served per-build) stays immutable-cached.
    const installerName = filePath.split(/[\\/]/).pop() || "";
    if (installerName.startsWith("LimeyV1Installer")) {
        headers["Cache-Control"] = "public, max-age=300";
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
    "/tools": "tools.html",
    "/rules": "rules.html",
    "/usrbg": "usrbg.html",
    "/download": "download.html",
    "/install": "install.html",
    "/limes": "limes.html",
    "/dashboard": "dashboard.html",
    "/submit-plugin": "submit-plugin.html",
    "/code": "code.html",
    "/404": "404.html",
    "/sdk": "sdk.html",
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

// Canonical clean URLs — every .html page we serve also answers at its
// extensionless name, and the .html spelling permanently 301-redirects to it
// (e.g. /tools.html -> /tools). Built from NAMED_PAGES plus the special
// routes that live outside it.
const HTML_REDIRECTS = new Map([
    ["/index.html", "/"],
    ["/docs/index.html", "/docs"],
    ["/admin.html", "/admin"],
    ["/verify.html", "/verify"],
    // Aliases with their own .html spelling
    ["/terms-of-service.html", "/terms-of-service"],
    ["/privacy-policy.html", "/privacy-policy"],
]);
for (const [clean, file] of Object.entries(NAMED_PAGES)) {
    // First key wins so /terms.html (not /terms-of-service) stays canonical
    if (/^[\w-]+\.html$/.test(file) && !HTML_REDIRECTS.has("/" + file)) {
        HTML_REDIRECTS.set("/" + file, clean);
    }
}

function redirectHtmlToClean(res, url) {
    const dest = HTML_REDIRECTS.get(url);
    if (!dest) return false;
    res.writeHead(301, { Location: dest, "Content-Type": "text/plain; charset=utf-8" });
    res.end(`301 Moved Permanently — the clean URL is ${dest}`);
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

// ------------------------------------------------------------------
// Admin support tools — one read-only look at everything we keep for a
// Discord user id: the ban list, USRBG banner, their synced cloud settings
// (which include their plugin list) and the Limes economy wallet. Read only;
// every use is audit-logged.
// ------------------------------------------------------------------
const CLOUD_PEPPER_SETTINGS = process.env.PEPPER_SETTINGS || "limeycloud-settings-pepper";

function cloudSettingsKey(userId) {
    // Mirrors cloud/util/util.go: sha1(pepper + userId) under the "settings:" prefix
    return "settings:" + createHash("sha1").update(CLOUD_PEPPER_SETTINGS + String(userId)).digest("hex");
}

async function readUserCloudSettings(userId) {
    if (!PGKV.pgEnabled() || !PGKV.getPool()) {
        return { found: false, error: "postgres kv unavailable — cloud settings live there" };
    }
    let row;
    try {
        const { rows } = await PGKV.getPool().query(
            `SELECT value::text, updated_at FROM limey_cloud_kv WHERE key = $1`,
            [cloudSettingsKey(userId)]
        );
        row = rows[0];
    } catch (err) {
        return { found: false, error: "cloud kv query failed: " + err.message };
    }
    if (!row) return { found: false };

    let hash;
    try { hash = JSON.parse(row.value); } catch {
        return { found: true, parseError: "unreadable cloud kv row", updatedAt: row.updated_at };
    }
    if (!hash || typeof hash !== "object") {
        return { found: true, parseError: "unexpected cloud kv shape", updatedAt: row.updated_at };
    }

    // The value is a raw deflate blob of the client settings. JSONB can't hold
    // invalid UTF-8, so the Go kv layer base64-wraps it under the "__b64" key.
    const storedValue = hash.value;
    let deflateBytes;
    if (storedValue && typeof storedValue === "object" && typeof storedValue.__b64 === "string") {
        deflateBytes = Buffer.from(storedValue.__b64, "base64");
    } else if (typeof storedValue === "string") {
        deflateBytes = Buffer.from(storedValue, "utf8");
    } else {
        return { found: true, parseError: "no settings blob stored", updatedAt: row.updated_at };
    }

    let settingsStr;
    try {
        // The client compresses with fflate's deflateSync — raw deflate.
        settingsStr = inflateRawSync(deflateBytes).toString("utf8");
    } catch {
        try {
            settingsStr = inflateSync(deflateBytes).toString("utf8");
        } catch {
            return {
                found: true, parseError: "could not decompress settings blob",
                bytes: deflateBytes.length, written: Number(hash.written || 0), updatedAt: row.updated_at
            };
        }
    }

    let settings;
    try { settings = JSON.parse(settingsStr); } catch {
        return { found: true, parseError: "settings blob is not valid JSON", written: Number(hash.written || 0), updatedAt: row.updated_at };
    }

    const pluginsObj = (settings && settings.plugins) || {};
    const enabledPlugins = [];
    let disabledCount = 0;
    for (const [name, p] of Object.entries(pluginsObj)) {
        if ((p && p.enabled) === true) enabledPlugins.push(name);
        else if (p && typeof p === "object") disabledCount++;
    }

    return {
        found: true,
        written: Number(hash.written || 0),
        updatedAt: row.updated_at,
        bytes: deflateBytes.length,
        highlights: {
            autoUpdate: settings.autoUpdate ?? null,
            notifications: settings.notifications ?? null,
            nativeTitleBar: settings.nativeTitleBar ?? null,
            cloudAuthenticated: !!(settings.cloud && settings.cloud.authenticated),
            settingsSyncEnabled: !!(settings.cloud && settings.cloud.settingsSync)
        },
        enabledPlugins,
        pluginCount: { enabled: enabledPlugins.length, disabled: disabledCount },
        // Full settings for the collapsible raw view in the admin panel
        raw: settings
    };
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
    // Public boot-time ban check for Limey V1 clients ({ bans } never
    // exposes who applied it).
    const bansCheckMatch = /^\/v1\/bans\/check\/(\d{5,25})$/.exec(url);
    if (bansCheckMatch) {
        const ban = bansData[bansCheckMatch[1]];
        if (!ban) return send(res, 200, JSON.stringify({ banned: false }), { "Content-Type": "application/json; charset=utf-8" }), true;
        return send(res, 200, JSON.stringify({ banned: true, reason: ban.reason || "", bannedAt: ban.bannedAt ?? null }), { "Content-Type": "application/json; charset=utf-8" }), true;
    }
    if (url === "/v1/bans/check") return send(res, 400, JSON.stringify({ error: "missing user id" }), { "Content-Type": "application/json; charset=utf-8" }), true;

    if (handleDiscordWebhooks(req, res, url)) return;
    if (url === "/linked-roles") return serveFile(res, join(PUBLIC, "verify.html")), true;
    if (url === "/deep-link") return serveDeepLink(req, res), true;
    if (url === "/connections/entrypoint") return serveConnectionsEntrypoint(req, res), true;

    // Canonical clean URLs: /tools.html -> 301 /tools (all named pages)
    if (redirectHtmlToClean(res, url)) return;

    // Named pages (plugins, tools, download, install, 404, verify, …)
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
        const state = params.get("state") || "";
        if (state === "dashboard" || state === "setup" || state === "admin") {
            // Dashboard login (optionally from the server-verification setup
            // section, or the admin panel): exchange the code and redirect
            // with a session token. The setup flow additionally carries the
            // guilds scope so the bot can list servers to configure. The
            // admin flow additionally requires the hardcoded admin role.
            const dest = await handleDashboardOAuth(params, state === "setup" ? params.get("guild_id") : null);
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
        // Limey Sentinel stats — admin-only snapshot for the /admin panel
        // (must run BEFORE the generic /v1/sentinel/* handler 404s it)
        if (sentinel && url === "/v1/sentinel/stats" && req.method === "GET") {
            const adminSession = dashGetSession(req);
            if (!adminSession?.admin) return json(res, 401, { error: "not authorized" }), true;
            return json(res, 200, sentinel.statsSnapshot()), true;
        }
        // Limey Sentinel proof-of-work captcha (handled in-process)
        if (sentinel && url.startsWith("/v1/sentinel/") && await sentinel.handle(req, res, url)) return;
        // Community plugin store (handled in-process)
        if (pluginStore && url.startsWith("/v1/plugins/") && await pluginStore.handle(req, res, url)) return;
        if (await handleStatus(req, res, url)) return;
        if (await handleBotState(req, res, url)) return;
        // USRBG API lives alongside /v1 (handled in-process)
        if (await handleUsrbg(req, res, url)) return;
        // Limey V1 Detector API (handled in-process)
        if (await handleDetector(req, res, url)) return;
        // Tools page lookup proxy (invite + guild widget)
        if (await handleToolsLookup(req, res, url)) return;
        // CORS-friendly media proxy for the GifCaptioner plugin
        if (await handleMediaProxy(req, res, url)) return;
        // Release-channel manifest (updaters / SDK / settings UI)
        if (releaseChannels && releaseChannels.handle(req, res, url)) return;
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
    startLimebot();

// Wait for PostgreSQL hydration (if configured) before accepting requests.
// The cloud sidecar is started AFTER the web server binds, so the first port
// exposed by process supervisors (e.g. the preview) is the real web server,
// not the internal cloud sidecar.
hydrateKv().then(() => {
    // Signing key may come from or be persisted to the database — resolve it
    // before the first request can be served.
    return initSigningKey();
}).then(() => {
    return kvGet("limey:status");
}).then(stored => {
    if (stored) {
        try { limeyStatus = JSON.parse(stored); } catch { /* ignore */ }
    }
}).then(() => {
    // Bring back channel snapshots the admin published before a restart —
    // dist/<channel>/ lives on ephemeral container disk.
    return restoreChannelSnapshots();
}).finally(() => {
    server.listen(PORT, HOST, () => {
        console.log(`Limey V1 web server running at http://${HOST}:${PORT} (persistent storage: ${KV_ENABLED ? "PostgreSQL" : "local files"})`);
        // Start the cloud settings-sync sidecar (binds on CLOUD_HOST:CLOUD_PORT)
        startCloud();
    });
});

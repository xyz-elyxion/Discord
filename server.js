/*
 * Limey V1 — static hosting server
 * Serves the website (public/) and build artifacts (dist/) with plain Node.js.
 * No external dependencies required.
 */

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const { createReadStream, existsSync, statSync } = require("fs");
const { join, extname, normalize, resolve } = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");
const CLOUD_BIN = join(ROOT, "cloud", "limeycloud-backend");
const CLOUD_PORT = Number(process.env.CLOUD_PORT) || 3099;
const CLOUD_HOST = "127.0.0.1";

// The Go redis client wants a bare host:port; accept full redis:// URLs too.
function normalizeRedisUri(uri) {
    if (!uri) return uri;
    const m = /^redis[s]?:\/\/([^/?]+)(?:\/|$)/.exec(uri.trim());
    return m ? m[1] : uri.trim();
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
            REDIS_URI: normalizeRedisUri(process.env.REDIS_URI) || "127.0.0.1:6379",
            ROOT_REDIRECT: process.env.ROOT_REDIRECT || "https://limey-discord.onrender.com",
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

function proxyCloud(req, res) {
    if (!cloudUp) return send(res, 503, "Cloud backend unavailable");

    const opts = {
        host: CLOUD_HOST,
        port: CLOUD_PORT,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${CLOUD_HOST}:${CLOUD_PORT}` }
    };

    const upstream = http.request(opts, upRes => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
    });
    upstream.on("error", () => send(res, 502, "Cloud backend error"));
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
    ".zip": "application/zip"
};

// Force browsers to download the userscript instead of trying to render it
const DOWNLOAD_TYPES = new Set([".user.js", ".zip"]);

function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
}

function serveFile(res, filePath) {
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
            res.writeHead(200, headers);
            stream.pipe(res);
        });
        stream.on("error", () => send(res, 500, "Internal server error"));
    } catch {
        send(res, 500, "Internal server error");
    }
}

const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);

    // Proxy /v1/* to the LimeyCloud (Go) backend
    if (url === "/v1" || url.startsWith("/v1/")) return proxyCloud(req, res);

    // Serve dist/ files under /dist/*
    if (url.startsWith("/dist/")) {
        const rel = normalize(url.slice("/dist/".length)).replace(/^(\.\.[/\\])+/, "");
        const filePath = resolve(DIST, rel);
        if (!filePath.startsWith(DIST)) return send(res, 403, "Forbidden");
        if (existsSync(filePath) && statSync(filePath).isFile()) return serveFile(res, filePath);
        return send(res, 404, "Not found");
    }

    // Serve static assets from public/
    let rel = normalize(url).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let filePath = resolve(PUBLIC, rel);

    if (!filePath.startsWith(PUBLIC)) return send(res, 403, "Forbidden");

    if (!existsSync(filePath)) {
        // SPA-ish fallback to the landing page
        filePath = join(PUBLIC, "index.html");
    } else if (statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
    }

    if (!existsSync(filePath)) return send(res, 404, "Not found");
    serveFile(res, filePath);
});

// ------------------------------------------------------------------
// Limebot (Discord bot, limebot/) — optional, enabled when LIMEBOT_TOKEN is set
// ------------------------------------------------------------------
function startLimebot() {
    if (!process.env.LIMEBOT_TOKEN) {
        console.log("[limebot] LIMEBOT_TOKEN not set — bot disabled");
        return;
    }
    if (!existsSync(join(ROOT, "limebot", "dist", "index.js"))) {
        console.log("[limebot] dist/index.js not found — bot disabled (was it built?)");
        return;
    }

    const child = spawn(process.execPath, ["--enable-source-maps", "."], {
        cwd: join(ROOT, "limebot"),
        env: { ...process.env, LIMEBOT: "1" },
        stdio: "inherit"
    });
    child.on("error", err => console.error("[limebot] failed to start:", err.message));
    child.on("exit", code => {
        if (code !== null) console.error(`[limebot] exited with code ${code}`);
    });
}

startCloud();
startLimebot();

server.listen(PORT, HOST, () => {
    console.log(`Limey V1 web server running at http://${HOST}:${PORT}`);
});

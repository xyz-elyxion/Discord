/*
 * Limey V1 — static hosting server
 * Serves the website (public/) and build artifacts (dist/) with plain Node.js.
 * No external dependencies required.
 */

"use strict";

const http = require("http");
const { createReadStream, existsSync, statSync } = require("fs");
const { join, extname, normalize, resolve } = require("path");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");

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

server.listen(PORT, HOST, () => {
    console.log(`Limey V1 web server running at http://${HOST}:${PORT}`);
});

/*
 * Limey V1 — Limey Sentinel (proof-of-work captcha backend)
 * Mounted at /v1/sentinel/* by server.js.
 *
 * Our own take on ALTCHA's Sentinel / POW captcha: a completely free,
 * self-hosted bot check with no third-party service, no data uploaded
 * anywhere, and no IP/behaviour tracking — the "captcha" is just a signed
 * math puzzle the browser solves on its own (SHA-256 proof-of-work).
 *
 * How it works:
 *   GET  /v1/sentinel/challenge -> { algorithm, challenge, expires, maxNumber,
 *                                    salt, signature }
 *   The browser brute-forces a number n so that sha256(salt + n) === challenge,
 *   then submits a base64url JSON payload { ...challenge, number } to the
 *   consumer endpoint. Consumers verify the payload signature (HMAC) before
 *   trusting anything in it, so planted metrics can't be forged and the TTL
 *   can't be extended by the client.
 *
 * Cross-process/single-instance persistence (sentinel.js):
 *   verifyPayload(payload, { consume: true }) marks the challenge hash as used
 *   so replays fail. Stateless use (default) never burns anything.
 */

"use strict";
const { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } = require("crypto");

const ALGORITHM = "SHA-256";
const VERSION = "limey-sentinel/1.0";
const DEFAULT_MAX_NUMBER = 500_000;
const MIN_MAX_NUMBER = 10_000;
const MAX_MAX_NUMBER = 3_000_000;
const TTL_MS = 5 * 60_000; // challenges must be consumed within 5 minutes

// Prefer an explicit shared secret (env: SENTINEL_SECRET) so a cluster of
// servers all validate the same signatures. Fall back to the admin token,
// and finally to a per-process random key (still unforgeable; challenges
// simply don't survive a restart).
const SECRET = process.env.SENTINEL_SECRET
    || process.env.USRBG_ADMIN_TOKEN
    || process.env.ADMIN_TOKEN
    || randomBytes(32).toString("base64url");

// Single-use ledger: challenge hash -> expires. Pruned opportunistically.
const used = new Map();

// ---------------------------------------------------------------------------
// Stats + adaptive difficulty (small-scale "Security Center")
// ---------------------------------------------------------------------------

const stats = { issued: 0, solved: 0, consumed: 0, rejected: {} };

// Per-IP failure tracking: repeated failed verifications (bots hammering the
// endpoint) make that IP's next challenges progressively harder. No reputation
// database — just a decaying Map. A successful solve clears the penalty.
const IP_FAIL_WINDOW_MS = 15 * 60_000;
const ipFailures = new Map(); // ip -> { count, updatedAt }

function noteRejected(reason) {
    stats.rejected[reason] = (stats.rejected[reason] || 0) + 1;
}

function noteIpFailure(ip) {
    if (!ip) return;
    const entry = ipFailures.get(ip) || { count: 0, updatedAt: 0 };
    entry.count += 1;
    entry.updatedAt = Date.now();
    ipFailures.set(ip, entry);
}

function noteIpSuccess(ip) {
    if (ip) ipFailures.delete(ip);
}

/** How much to inflate the difficulty for this IP: 1x normally, 4x after
 *  3 recent failures, 10x after 10. */
function difficultyMultiplierFor(ip) {
    const entry = ipFailures.get(ip);
    if (!entry) return 1;
    if (Date.now() - entry.updatedAt > IP_FAIL_WINDOW_MS) {
        ipFailures.delete(ip);
        return 1;
    }
    if (entry.count >= 10) return 10;
    if (entry.count >= 3) return 4;
    return 1;
}

function pruneIpFailures() {
    for (const [ip, entry] of ipFailures) {
        if (Date.now() - entry.updatedAt > IP_FAIL_WINDOW_MS) ipFailures.delete(ip);
    }
}

function clientIp(req) {
    return String(req?.headers?.["x-forwarded-for"] || "")
        .split(",")[0].trim()
        || req?.socket?.remoteAddress
        || "";
}

/** Opaque snapshot for the admin dashboard. Never exposes IPs — only counts. */
function statsSnapshot() {
    pruneIpFailures();
    return {
        issued: stats.issued,
        solved: stats.solved,
        consumed: stats.consumed,
        rejected: { ...stats.rejected },
        totalRejected: Object.values(stats.rejected).reduce((n, c) => n + c, 0),
        activeChallenges: used.size,
        watchlistedIps: ipFailures.size,
    };
}

// ---------------------------------------------------------------------------
// Challenge creation + verification
// ---------------------------------------------------------------------------

function hmacSignature(salt, algorithm, challenge, maxNumber, expires) {
    return createHmac("sha256", SECRET)
        .update([salt, algorithm, challenge, String(maxNumber), String(expires)].join("|"))
        .digest("base64url");
}

function createChallenge(maxNumber = DEFAULT_MAX_NUMBER, difficultyMultiplier = 1) {
    maxNumber = Math.min(
        Math.max(Math.floor(Number(maxNumber) || DEFAULT_MAX_NUMBER), MIN_MAX_NUMBER),
        MAX_MAX_NUMBER
    );
    maxNumber = Math.min(Math.round(maxNumber * difficultyMultiplier), MAX_MAX_NUMBER * difficultyMultiplier);
    maxNumber = Math.min(maxNumber, 30_000_000); // absolute ceil even at 10x
    const salt = randomBytes(12).toString("hex");
    const number = randomInt(1, maxNumber);
    const challenge = createHash("sha256").update(`${salt}${number}`).digest("hex");
    const expires = Date.now() + TTL_MS;
    return {
        algorithm: ALGORITHM,
        challenge,
        expires,
        maxNumber,
        salt,
        signature: hmacSignature(salt, ALGORITHM, challenge, maxNumber, expires),
        version: VERSION,
    };
}

function parsePayload(raw) {
    if (typeof raw !== "string" || !raw.length) return null;
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
        try {
            const p = JSON.parse(trimmed);
            return p && typeof p === "object" && !Array.isArray(p) ? p : null;
        } catch {
            return null;
        }
    }
    try {
        const decoded = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        const p = JSON.parse(decoded);
        return p && typeof p === "object" && !Array.isArray(p) ? p : null;
    } catch {
        return null;
    }
}

function pruneUsed() {
    for (const [challenge, expires] of used) {
        if (expires < Date.now() - TTL_MS) used.delete(challenge);
    }
}

/**
 * Verify a sentinel payload (base64url or raw JSON object).
 * opts.consume marks the challenge as used so a second verification fails.
 * Returns { ok: true } { ok: false, error: "reason" }.
 */
function verifyPayload(raw, opts = {}) {
    const p = parsePayload(raw);
    if (!p) {
        noteRejected("invalid payload");
        return { ok: false, error: "invalid payload" };
    }
    if (p.algorithm !== ALGORITHM) {
        noteRejected("unsupported algorithm");
        return { ok: false, error: "unsupported algorithm" };
    }

    const { salt, challenge, number, maxNumber, signature, expires } = p;
    if (typeof salt !== "string" || !/^[0-9a-f]{8,64}$/.test(salt)) {
        noteRejected("bad salt");
        return { ok: false, error: "bad salt" };
    }
    if (typeof challenge !== "string" || !/^[0-9a-f]{64}$/.test(challenge)) {
        noteRejected("bad challenge");
        return { ok: false, error: "bad challenge" };
    }
    if (!Number.isInteger(expires) || expires < Date.now()) {
        noteRejected("challenge expired");
        return { ok: false, error: "challenge expired" };
    }
    if (expires > Date.now() + TTL_MS * 2) {
        noteRejected("expiry too far out");
        return { ok: false, error: "challenge expiry too far out" };
    }
    if (!Number.isInteger(maxNumber) || maxNumber < MIN_MAX_NUMBER || maxNumber > 30_000_000) {
        noteRejected("bad maxNumber");
        return { ok: false, error: "bad maxNumber" };
    }
    if (!Number.isInteger(number) || number < 0 || number > maxNumber) {
        noteRejected("bad number");
        return { ok: false, error: "bad number" };
    }

    if (typeof signature !== "string") {
        noteRejected("missing signature");
        return { ok: false, error: "missing signature" };
    }
    const expected = hmacSignature(salt, p.algorithm, challenge, maxNumber, expires);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        noteRejected("bad signature");
        return { ok: false, error: "bad signature" };
    }

    const computed = createHash("sha256").update(`${salt}${number}`).digest("hex");
    if (computed !== challenge) {
        noteRejected("puzzle mismatch");
        return { ok: false, error: "puzzle mismatch" };
    }

    noteIpSuccess(opts.ip);
    stats.solved += 1;

    if (opts.consume) {
        if (used.has(challenge)) {
            noteRejected("replay");
            return { ok: false, error: "challenge already used" };
        }
        used.set(challenge, expires);
        stats.consumed += 1;
        if (used.size > 20_000) pruneUsed();
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        ...headers,
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, limit = 100_000) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > limit) {
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

async function handle(req, res, url) {
    const method = req.method || "GET";

    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
        });
        return res.end(), true;
    }

// GET /v1/sentinel/challenge — increment the issued counter too.
    if (method === "GET" && (url === "/v1/sentinel/challenge" || url.startsWith("/v1/sentinel/challenge?"))) {
        stats.issued += 1;
        let maxNumber = DEFAULT_MAX_NUMBER;
        try {
            const query = new URL("http://localhost" + url).searchParams;
            if (query.has("maxnumber")) maxNumber = Number(query.get("maxnumber"));
        } catch { /* default difficulty */ }
        return send(res, 200, createChallenge(maxNumber, difficultyMultiplierFor(clientIp(req)))), true;
    }

    // POST /v1/sentinel/verify — stateless check { captcha | payload }.
    // This never consumes the challenge; consumers decide whether to burn it.
    if (method === "POST" && (url === "/v1/sentinel/verify" || url.startsWith("/v1/sentinel/verify?"))) {
        let raw = "";
        try {
            raw = await readBody(req);
        } catch {
            return send(res, 400, { ok: false, error: "failed to read body" }), true;
        }
        try {
            const parsed = raw.trim().startsWith("{") ? JSON.parse(raw) : null;
            const payload = typeof parsed?.captcha === "string"
                ? parsed.captcha
                : typeof parsed?.payload === "string"
                    ? parsed.payload
                    : raw;
            const ip = clientIp(req);
            const result = verifyPayload(payload, { ip });
            if (!result.ok) {
                noteIpFailure(ip);
                return send(res, 403, result), true;
            }
            return send(res, 200, { ok: true }), true;
        } catch {
            return send(res, 400, { ok: false, error: "invalid request" }), true;
        }
    }

    if (url === "/v1/sentinel" || url.startsWith("/v1/sentinel/")) {
        return send(res, 404, { ok: false, error: "not found" }), true;
    }
    return false;
}

module.exports = { handle, createChallenge, verifyPayload, statsSnapshot, noteIpFailure, ALGORITHM, VERSION, DEFAULT_MAX_NUMBER, TTL_MS };

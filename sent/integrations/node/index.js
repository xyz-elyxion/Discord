/**
 * Limey Guard — Node.js / Express integration (ESM and CJS compatible).
 *
 * Usage:
 *
 *   const { sentinelGuard } = require("limey-guard-node");
 *   // or: import { sentinelGuard } from "limey-guard-node";
 *
 *   app.post("/api/contact",
 *     sentinelGuard({ tokenSecret: process.env.SENTINEL_TOKEN_SECRET, siteKey: "sk", action: "contact-form" }),
 *     handler,
 *   );
 *
 * The middleware verifies signature, expiry, site/action/hostname binding and
 * rejects replay (per-process memory or a shared replay via a custom resolve).
 */
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

const MIN_SECRET = 32;
const TOKEN_VERSION = 1;

/**
 * Verify the structure and signature of a Sentinel verification token.
 * Returns { payload } on success; throws an Error with .code otherwise.
 */
export function verifyToken(token, tokenSecret, expected = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    throw codeErr("token_invalid", "missing or oversized token");
  }
  const parts = token.split(".");
  if (parts.length !== 2) throw codeErr("token_invalid", "malformed token");
  const [payloadB64, sigB64] = parts;

  const expectedSig = createHmac("sha256", tokenSecret).update(payloadB64).digest();
  let got;
  try {
    got = Buffer.from(sigB64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    throw codeErr("token_invalid", "bad signature encoding");
  }
  if (got.length !== expectedSig.length || !timingSafeEqual(got, expectedSig)) {
    throw codeErr("token_signature", "signature mismatch");
  }
  let payloadRaw;
  try {
    payloadRaw = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    throw codeErr("token_invalid", "bad payload encoding");
  }
  let p;
  try {
    p = JSON.parse(payloadRaw);
  } catch {
    throw codeErr("token_invalid", "payload not JSON");
  }
  if (p.v !== TOKEN_VERSION) throw codeErr("token_invalid", "unsupported version");
  if (!p.exp || Math.floor(Date.now() / 1000) > p.exp) throw codeErr("token_expired", "token expired");
  if (expected.siteKey && p.sid !== expected.siteKey) throw codeErr("token_binding", "site mismatch");
  if (expected.action && p.act && p.act !== expected.action) throw codeErr("token_binding", "action mismatch");
  if (expected.host && p.host && p.host !== expected.host) throw codeErr("token_binding", "host mismatch");
  return p;
}

function codeErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

class MemoryReplay {
  constructor() { this.seen = new Map(); }
  consume(id, ttlMs) {
    const now = Date.now();
    if (this.seen.size > 100_000) {
      for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    }
    const exp = this.seen.get(id);
    if (exp && exp > now) return false;
    this.seen.set(id, now + (ttlMs || 120_000));
    return true;
  }
}

/**
 * Express-compatible middleware factory.
 */
export function sentinelGuard(options = {}) {
  const {
    tokenSecret,
    siteKey,
    action = "",
    headerName = "x-sentinel-token",
    replay = new MemoryReplay(),
    bindHost = true,
  } = options;
  if (!tokenSecret || tokenSecret.length < MIN_SECRET) {
    throw new Error("sentinelGuard: tokenSecret must be at least " + MIN_SECRET + " bytes");
  }
  if (!siteKey) throw new Error("sentinelGuard: siteKey is required");
  return function guard(req, res, next) {
    const token = req.get(headerName) || (req.cookies && req.cookies[headerName]);
    if (!token) {
      res.set("X-Sentinel-Required", "true");
      return res.status(403).json({ error: { code: "verification_required", message: "Provide a valid verification token" } });
    }
    let host = (req.hostname || req.headers.host || "").toLowerCase();
    host = host.replace(/:\d+$/, "");
    let payload;
    try {
      payload = verifyToken(token, tokenSecret, { siteKey, action, host: bindHost ? host : "" });
    } catch (err) {
      const status = err.code === "token_expired" ? 401 : err.code === "token_replayed" ? 403 : 403;
      return res.status(status).json({ error: { code: err.code, message: "Token rejected" } });
    }
    const remainingMs = Math.max(0, (payload.exp * 1000) - Date.now());
    if (!replay.consume(payload.jti || hashToken(token), remainingMs)) {
      return res.status(403).json({ error: { code: "token_replayed", message: "Token already used" } });
    }
    req.sentinel = payload;
    next();
  };
}

export default { sentinelGuard, verifyToken };

// Tests for the Node integration. Run: node --test index.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sentinelGuard, verifyToken } from "./index.js";

const SECRET = "0123456789abcdef0123456789abcdef-0123456789abcdef";

function b64u(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function sign(payloadB64) {
  return createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}
function mintToken(payload) {
  const p = b64u(payload);
  return p + "." + sign(p);
}

test("verifyToken accepts a valid token", () => {
  const tok = mintToken({ v: 1, sid: "sk", act: "contact", host: "a.test", exp: Math.floor(Date.now() / 1000) + 60, jti: "j1" });
  const p = verifyToken(tok, SECRET, { siteKey: "sk", action: "contact", host: "a.test" });
  assert.equal(p.sid, "sk");
});

test("verifyToken rejects tampering", () => {
  const tok = mintToken({ v: 1, sid: "sk", exp: Math.floor(Date.now() / 1000) + 60, jti: "j" });
  const tampered = "AAAA" + tok.slice(4);
  assert.throws(() => verifyToken(tampered, SECRET, { siteKey: "sk" }), /signature/);
});

test("verifyToken rejects wrong site", () => {
  const tok = mintToken({ v: 1, sid: "other", exp: Math.floor(Date.now() / 1000) + 60, jti: "j" });
  assert.throws(() => verifyToken(tok, SECRET, { siteKey: "sk" }), /site mismatch/);
});

test("verifyToken rejects expired", () => {
  const tok = mintToken({ v: 1, sid: "sk", exp: Math.floor(Date.now() / 1000) - 10, jti: "j" });
  assert.throws(() => verifyToken(tok, SECRET, { siteKey: "sk" }), /expired/);
});

function mockReqRes({ token, host = "a.test", existingJti = null, replay } = {}) {
  const headers = {};
  if (token) headers["x-sentinel-token"] = token;
  const req = {
    headers,
    hostname: host,
    get: (n) => headers[n.toLowerCase()],
    cookies: {},
  };
  const out = { status: 0, body: null, sent: false };
  const res = {
    set: () => res,
    status(code) { out.status = code; return res; },
    json(b) { out.body = b; out.sent = true; return res; },
  };
  let calledNext = false;
  const next = () => { calledNext = true; };
  return { req, res, out, isNext: () => calledNext };
}

async function run(mock, opts) {
  const guard = sentinelGuard({ tokenSecret: SECRET, siteKey: "sk", action: "contact", ...opts });
  await new Promise((resolve) => guard(mock.req, mock.res, resolve));
  return mock;
}

test("middleware enforces token presence", async () => {
  const m = mockReqRes({});
  const r = await run(m);
  assert.equal(r.out.status, 403);
  assert.equal(r.isNext(), false);
});

test("middleware passes a fresh token and rejects replay", async () => {
  const replay = { seen: new Map(), consume(id, ttl) { 
    if (this.seen.has(id)) return false; this.seen.set(id, Date.now() + ttl); return true; } };
  const tok = mintToken({ v: 1, sid: "sk", act: "contact", host: "a.test", exp: Math.floor(Date.now() / 1000) + 60, jti: "jti-x" });
  const first = mockReqRes({ token: tok });
  const r1 = await run(first, { replay });
  assert.ok(r1.isNext(), "first request passes");

  const second = mockReqRes({ token: tok });
  const r2 = await run(second, { replay });
  assert.equal(r2.out.status, 403, "replay blocked");
});

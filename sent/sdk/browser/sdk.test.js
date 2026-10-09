// SDK unit tests for the exported helpers via the built bundle behavior.
// Run: node --test sdk.test.js  (uses the ESM source directly)
import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal crypto.subtle shim for Node (Node >= 19 has global crypto).
import * as esbuild from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "sdktest-"));
writeFileSync(join(dir, "sdk.ts"), (await import("node:fs")).readFileSync(new URL("./sdk.ts", import.meta.url)));
await esbuild.build({
  entryPoints: [join(dir, "sdk.ts")],
  bundle: true,
  format: "esm",
  outfile: join(dir, "sdk.mjs"),
  target: ["node18"],
});
const { protect } = await import("file://" + join(dir, "sdk.mjs"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const TOKEN_SECRET_FREE = ""; // not used; tokens are opaque strings here

function fakeServer() {
  // difficulty-12 target requires ~4096 tries avg; keep difficulty small for tests
  const challenges = [
    {
      challenge: "AAAA-test-challenge",
      salt: "somesalt",
      difficulty: 12,
      maxnumber: 500000,
      siteKey: "sk",
      action: "contact",
      expiresIn: 120,
    },
  ];
  let used = false;
  let calls = 0;
  return {
    fetch: async (url, init) => {
      calls++;
      if (url.endsWith("/v1/challenge")) {
        const ch = challenges[0];
        // simulate expiry mid-solve: after first verify attempt fails once
        return new Response(JSON.stringify(ch), { status: 200 });
      }
      if (url.endsWith("/v1/verify")) {
        const body = JSON.parse(init.body);
        assert.equal(body.siteKey, "sk");
        // accept: return token
        return new Response(JSON.stringify({ verified: true, token: "tok." + used, expiresIn: 120 }), { status: 200 });
      }
      throw new Error("unexpected url " + url);
    },
    callCount: () => calls,
  };
}

test("protect returns a verified token on the happy path", async () => {
  const srv = fakeServer();
  const orig = globalThis.fetch;
  globalThis.fetch = srv.fetch;
  try {
    const res = await protect({
      sentinelUrl: "https://sentinel.test",
      siteKey: "sk",
      action: "contact",
      hostname: "example.test",
    });
    assert.equal(res.verified, true);
    assert.ok(res.token.startsWith("tok."));
  } finally {
    globalThis.fetch = orig;
  }
});

test("protect surfaces server error codes", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "site", message: "unknown" } }), { status: 404 });
  try {
    const res = await protect({ sentinelUrl: "https://sentinel.test", siteKey: "bogus" });
    assert.equal(res.verified, false);
    assert.equal(res.error, "site");
  } finally {
    globalThis.fetch = orig;
  }
});

test("protect honors solve timeout", async () => {
  const orig = globalThis.fetch;
  // difficulty 22 would take too long; use maxnumber trick: impossible-to-solve with tiny deadline
  globalThis.fetch = async (url) => {
    if (url.endsWith("/v1/challenge")) {
      return new Response(JSON.stringify({
        challenge: "c", salt: "s", difficulty: 24, maxnumber: 10_000_000,
        siteKey: "sk", expiresIn: 120,
      }), { status: 200 });
    }
    throw new Error("unexpected");
  };
  try {
    const res = await protect({
      sentinelUrl: "https://sentinel.test",
      siteKey: "sk",
      solveTimeoutMs: 150,
      tickMs: 1,
    });
    assert.equal(res.verified, false);
    assert.equal(res.error, "solve_timeout");
  } finally {
    globalThis.fetch = orig;
  }
});

// E2E helper: solves a challenge from /tmp/ch.json, exercises /v1/verify and
// /v1/token/validate, and prints the outcome of each call.
// Usage: node tests/solve.mjs  (after downloading a challenge to /tmp/ch.json)
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ch = JSON.parse(readFileSync("/tmp/ch.json", "utf8"));
const { salt, difficulty } = ch;
const t0 = Date.now();
let nonce = -1;
for (let i = 0; i < ch.maxnumber * 4; i++) {
  const d = createHash("sha256").update(salt + String(i)).digest();
  let ok = true;
  const full = Math.floor(difficulty / 8);
  for (let k = 0; k < full; k++) if (d[k] !== 0) { ok = false; break; }
  if (ok && difficulty % 8 === 0) {
    // met
  } else if (ok) {
    const b = d[full];
    for (let bit = 7; bit >= 8 - difficulty % 8; bit--) {
      if ((b >> bit) & 1) { ok = false; break; }
    }
  }
  if (ok) { nonce = i; break; }
}
if (nonce < 0) { console.error("no solution found"); process.exit(1); }
console.error(`solved nonce=${nonce} in ${Date.now() - t0}ms`);

const body = JSON.stringify({
  siteKey: ch.siteKey,
  action: ch.action,
  challenge: ch.challenge,
  salt: ch.salt,
  difficulty,
  signature: ch.signature,
  nonce: Buffer.from(String(nonce)).toString("base64url"),
  hostname: "example.test",
});

const res = await fetch("http://127.0.0.1:8090/v1/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body,
});
var out = await res.json();
console.log("verify:", res.status, JSON.stringify(out));
if (!out.verified) process.exit(1);

{
  const res2 = await fetch("http://127.0.0.1:8090/v1/token/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: ch.siteKey, token: out.token, hostname: "example.test", action: ch.action }),
  });
  console.log("first validate:", res2.status, JSON.stringify(await res2.json()));
  const res3 = await fetch("http://127.0.0.1:8090/v1/token/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: ch.siteKey, token: out.token, hostname: "example.test", action: ch.action }),
  });
  console.log("replay validate (expect 4xx):", res3.status, JSON.stringify(await res3.json()));
  const res4 = await fetch("http://127.0.0.1:8090/v1/token/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey: ch.siteKey, token: out.token, hostname: "evil.test", action: ch.action }),
  });
  console.log("cross-host validate (expect 4xx):", res4.status, JSON.stringify(await res4.json()));
}

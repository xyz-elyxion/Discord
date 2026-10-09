import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ch = JSON.parse(readFileSync("/tmp/ch.json", "utf8"));
let best = 0, bestI = -1;
for (let i = 0; i < ch.maxnumber; i++) {
  const d = createHash("sha256").update(ch.salt + String(i)).digest();
  let zz = 0;
  outer: for (const byte of d) {
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) break outer;
      zz++;
    }
  }
  if (zz > best) { best = zz; bestI = i; }
}
console.log("best nonce:", bestI, "leading zero bits:", best, "needed:", ch.difficulty);

/**
 * Limey Guard — browser SDK.
 *
 * Usage:
 *
 *   const guard = await LimeyGuard.protect({
 *     sentinelUrl: "https://sentinel.example.com",
 *     siteKey: "PUBLIC_SITE_KEY",
 *     action: "contact-form",
 *   });
 *   if (guard.verified) {
 *     // attach guard.token to your request, e.g. as X-Sentinel-Token header,
 *     // or let the middleware read it from the injected global.
 *   }
 *
 * The SDK never contains private keys: the site key is public by design; the
 * per-site signing secret stays server-side.
 *
 * Note on proof-of-work: solving a PoW raises the cost of scripted abuse but
 * is not proof of humanity — see docs/security.md for limitations.
 */

export interface ProtectOptions {
  /** Base URL of the Sentinel deployment (no trailing slash). */
  sentinelUrl: string;
  /** Public site key issued in the dashboard. */
  siteKey: string;
  /** Logical action name bound into the challenge (e.g. "contact-form"). */
  action?: string;
  /** Optional hostname to bind the issued token to (defaults to location.host). */
  hostname?: string;
  /** Max wall-clock time for solving, ms (default 8000). */
  solveTimeoutMs?: number;
  /** Poll interval for progress, ms (default 4). */
  tickMs?: number;
  /** Progress callback (0..1). */
  onProgress?: (fraction: number) => void;
}

export interface ProtectResult {
  verified: boolean;
  /** Signed verification token; send it to your backend. */
  token: string;
  /** ISO error code when verified === false. */
  error?: string;
  /** Human-friendly, localized-safe message code for UI rendering. */
  messageCode?: string;
}

interface ChallengePayload {
  challenge: string;
  salt: string;
  difficulty: number;
  maxnumber: number;
  siteKey: string;
  action?: string;
  expiresIn: number;
}

const b64u = {
  enc: (bytes: Uint8Array): string => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
};

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

function leadingZeroBits(digest: Uint8Array, bits: number): boolean {
  let full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) {
    if (digest[i] !== 0) return false;
  }
  const rem = bits % 8;
  if (rem !== 0) {
    const b = digest[full];
    for (let i = 0; i < rem; i++) {
      if ((b << i) & 0x80) return false;
    }
  }
  return true;
}

async function solve(ch: ChallengePayload, opts: ProtectOptions, deadline: number): Promise<string> {
  let nonce = 0;
  const max = ch.maxnumber || 1_000_000;
  const tickMs = opts.tickMs ?? 4;
  while (nonce < max) {
    // Batch without awaiting between hashes that would starve the event loop;
    // check the clock every 256 tries.
    for (let k = 0; k < 256 && nonce < max; k++, nonce++) {
      const digest = await sha256(ch.salt + String(nonce));
      if (leadingZeroBits(digest, ch.difficulty)) {
        opts.onProgress?.(1);
        return b64u.enc(new TextEncoder().encode(String(nonce)));
      }
    }
    opts.onProgress?.(Math.min(1, nonce / max));
    if (Date.now() > deadline) throw new Error("sentinel:solve_timeout");
    await new Promise((r) => setTimeout(r, tickMs));
  }
  throw new Error("sentinel:exhausted");
}

/** Request a challenge from the server. */
async function fetchChallenge(base: string, siteKey: string, action: string): Promise<ChallengePayload> {
  const res = await fetch(`${base}/v1/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ siteKey, action }),
  });
  if (!res.ok) {
    let code = "challenge_http_" + res.status;
    try {
      const body = await res.json();
      if (body?.error?.code) code = body.error.code;
    } catch {
      /* keep http code */
    }
    throw new Error("sentinel:" + code);
  }
  return res.json();
}

/** Submit the solution and exchange it for a verification token. */
async function submitSolution(base: string, ch: ChallengePayload, nonce: string, hostname: string): Promise<string> {
  const res = await fetch(`${base}/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: ch.siteKey,
      action: ch.action ?? "",
      challenge: ch.challenge,
      salt: ch.salt,
      difficulty: ch.difficulty,
      nonce,
      hostname,
    }),
  });
  if (!res.ok) {
    let code = "verify_http_" + res.status;
    try {
      const body = await res.json();
      if (body?.error?.code) code = body.error.code;
    } catch {
      /* ignore */
    }
    throw new Error("sentinel:" + code);
  }
  const body = await res.json();
  return body.token as string;
}

/**
 * Run the full flow: fetch → solve → verify → return token.
 * Expired challenges are retried once automatically.
 */
export async function protect(opts: ProtectOptions): Promise<ProtectResult> {
  const base = opts.sentinelUrl.replace(/\/+$/, "");
  const action = opts.action ?? "";
  const hostname = opts.hostname ?? (typeof location !== "undefined" ? location.host : "");
  const deadline = Date.now() + (opts.solveTimeoutMs ?? 8000);

  try {
    let ch = await fetchChallenge(base, opts.siteKey, action);
    if (typeof opts.onProgress === "function") opts.onProgress(0);
    const nonce = await solve(ch, opts, deadline);
    try {
      const token = await submitSolution(base, ch, nonce, hostname);
      return { verified: true, token };
    } catch (err) {
      // single safe retry on expiry (the challenge may have aged out mid-solve)
      if (err instanceof Error && err.message.endsWith("challenge_expired")) {
        ch = await fetchChallenge(base, opts.siteKey, action);
        const retryNonce = await solve(ch, opts, Math.max(deadline, Date.now() + 4000));
        const token = await submitSolution(base, ch, retryNonce, hostname);
        return { verified: true, token };
      }
      throw err;
    }
  } catch (err) {
    const code = err instanceof Error ? err.message.replace(/^sentinel:/, "") : "unknown";
    return {
      verified: false,
      token: "",
      error: code,
      messageCode: "sentinel_error_" + code,
    };
  }
}

export const LimeyGuard = { protect };
export default LimeyGuard;

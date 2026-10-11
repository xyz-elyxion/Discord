/*
 * Limey V1 — Limey Sentinel browser widget (self-hosted POW captcha)
 *
 * Our own ALTCHA-inspired proof-of-work captcha: the browser fetches a
 * signed challenge from /v1/sentinel/challenge, brute-forces the number n
 * with WebCrypto (sha256(salt + n) === challenge), and hands back a
 * base64url payload to attach to your request. Nothing is uploaded, no
 * third-party service, no tracking — just math.
 *
 * Zero dependencies; only Needs: window.crypto.subtle (all modern browsers).
 *
 * Public API
 * ----------
 * sentinel.getChallenge(maxNumber?)  → raw challenge object from the server
 * sentinel.solve(challenge)          → { ok, payload, number, error, tookMs }
 * sentinel.verify(payload)           → POST /v1/sentinel/verify (stateless)
 * sentinel.run()                     → one-shot: challenge + solve + verify
 * sentinel.attach(element?, opts?)   → build an inline "Verify" checkbox
 *                                      that self-animates and yields a payload
 */

(() => {
    "use strict";
    if (window.sentinel) return; // idempotent

    if (typeof window.baseurl === "undefined") window.baseurl = "";

    const DEFAULT_MAX_NUMBER = 500_000;
    const STANDARD_BATCH = 10_000;

    function toBase64Url(bytes) {
        let bin = "";
        for (const byte of bytes) bin += String.fromCharCode(byte);
        return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function payloadToBase64Url(payload) {
        return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    }

    async function getChallenge(maxNumber) {
        const url = `${window.baseurl}/v1/sentinel/challenge` +
            (maxNumber != null ? `?maxnumber=${encodeURIComponent(maxNumber)}` : "");
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) throw new Error(`failed to fetch challenge (${res.status})`);
        return await res.json();
    }

    // Brute-force sha256(salt + n) === challenge, batched to keep the main
    // thread responsive (yield to the browser between batches). Long batches
    // would block paint; this keeps the UI usable even on slow devices.
    async function solve(challenge) {
        const start = performance.now();
        const { challenge: target, salt, signature, algorithm, maxNumber, expires } = challenge;
        const payload = { algorithm, challenge: target, salt, signature, maxNumber, expires };

        if (algorithm !== "SHA-256") {
            return { ok: false, error: `unsupported algorithm: ${algorithm}`, tookMs: 0 };
        }
        // SHA-256 via WebCrypto — available in every browser since ~2016.
        if (!window.crypto?.subtle) {
            return { ok: false, error: "WebCrypto not available in this browser.", tookMs: 0 };
        }

        const encoder = new TextEncoder();
        for (let n = 0; n <= maxNumber; n += STANDARD_BATCH) {
            const end = Math.min(n + STANDARD_BATCH, maxNumber + 1);
            const found = await solveBatch(salt, target, encoder, n, end);
            if (found !== null) {
                payload.number = found;
                return {
                    ok: true,
                    payload: payloadToBase64Url(payload),
                    number: found,
                    tookMs: Math.round(performance.now() - start),
                };
            }
            // yield so the page stays responsive during longer batches
            await new Promise(r => setTimeout(r, 0));
        }
        return {
            ok: false,
            error: `failed to solve — search space exhausted (0..${maxNumber})`,
            tookMs: Math.round(performance.now() - start),
        };
    }

    async function solveBatch(salt, target, encoder, from, to) {
        for (let n = from; n < to; n++) {
            const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}${n}`));
            if (toHex(new Uint8Array(digest)) === target) return n;
        }
        return null;
    }

    function toHex(bytes) {
        let hex = "";
        for (const b of bytes) hex += b.toString(16).padStart(2, "0");
        return hex;
    }

    // Optional server-side double-check (stateless; does NOT consume).
    async function verify(payload) {
        const res = await fetch(`${window.baseurl}/v1/sentinel/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ captcha: payload }),
            credentials: "omit",
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, ...data };
    }

    // One-shot: issue, solve, (optionally) verify. Returns { ok, payload }.
    async function run({ maxNumber, verifyAgainstServer = false } = {}) {
        const challenge = await getChallenge(maxNumber);
        const result = await solve(challenge);
        if (!result.ok) return result;
        if (verifyAgainstServer) {
            const check = await verify(result.payload);
            if (!check.ok) return { ok: false, error: check.error ?? "server-side verification failed", tookMs: result.tookMs };
        }
        return result;
    }

    // Inline widget: a lime checkbox that flips to a spinner while working
    // and shows the label "I'm not a bot". resolve() gives you the payload.
    function attach(element, opts = {}) {
        const mount = typeof element === "string" ? document.querySelector(element) : element;
        if (!mount) throw new Error("sentinel.attach: no mount element");

        let resolveFn = opts.onComplete || (() => {});
        const root = document.createElement("div");
        root.className = "sentinel-root";
        root.innerHTML = `
            <label class="sentinel-box">
                <span class="sentinel-check" aria-hidden="true"></span>
                <span class="sentinel-label">I'm not a bot</span>
                <span class="sentinel-status"></span>
            </label>`;
        mount.appendChild(root);

        const box = root.querySelector(".sentinel-box");
        const check = root.querySelector(".sentinel-check");
        const statusEl = root.querySelector(".sentinel-status");
        let done = false;

        async function work() {
            if (done) return true;
            statusEl.textContent = "working…";
            root.classList.add("is-busy");
            try {
                const res = await run({ maxNumber: opts.maxNumber });
                if (!res.ok) throw new Error(res.error || "failed");
                done = true;
                root.classList.remove("is-busy");
                root.classList.add("is-done");
                statusEl.textContent = "";
                resolveFn(res);
                return true;
            } catch (e) {
                root.classList.remove("is-busy");
                statusEl.textContent = "failed — click to retry";
                statusEl.classList.add("is-error");
                box.dataset.error = String(e?.message ?? e);
                return false;
            }
        }

        box.setAttribute("role", "checkbox");
        box.setAttribute("tabindex", "0");
        box.addEventListener("click", () => {
            if (done) { opts.onRedo?.(); done = false; root.classList.remove("is-done"); statusEl.textContent = ""; }
            else work();
        });
        box.addEventListener("keydown", e => {
            if (e.key === " " || e.key === "Enter") { e.preventDefault(); box.click(); }
        });

        if (opts.autostart !== false) work();

        return {
            isDone: () => done,
            result: () => new Promise(resolve => { resolveFn = resolve; }),
            reset: () => { done = false; root.classList.remove("is-done", "is-busy"); statusEl.textContent = ""; work(); },
        };
    }

    window.sentinel = {
        getChallenge,
        solve,
        verify,
        run,
        attach,
    };
})();

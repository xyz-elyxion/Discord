/*
 * Limey site remote — the website tries to talk to Limey V1 ("the app").
 *
 * When the Limey browser extension is installed, its content script also runs
 * on this site (declared in the manifests) and answers our pings. From there
 * the page can relay whitelisted commands straight into any open discord.com
 * tab, where Limey's WebPWA plugin maps them onto real app actions
 * (mute, deafen, VAD, streamer mode, go live, save clip, navigate).
 * Everything is best-effort: without the extension the widget simply stays
 * in its "not detected" state and offers the download instead.
 */

(function () {
    "use strict";

    const container = document.getElementById("limey-remote");
    if (!container) return;

    const statusEl = container.querySelector(".remote-status");
    const hintEl = container.querySelector(".remote-hint");
    const buttons = Array.from(container.querySelectorAll("[data-command]"));
    const connectBtn = container.querySelector("[data-open-app]");

    let connected = false;

    function setStatus(state, version) {
        if (!statusEl) return;
        if (state === "connected") {
            statusEl.textContent = "🟢 Connected · Limey V1 " + (version || "");
            statusEl.classList.add("remote-status-on");
            statusEl.classList.remove("remote-status-off");
            if (hintEl) hintEl.textContent = "Click a button — the app does it, live in your Discord tab.";
        } else {
            statusEl.textContent = "🍋 Searching for Limey V1…";
            statusEl.classList.remove("remote-status-on");
            statusEl.classList.add("remote-status-off");
            if (hintEl) hintEl.textContent = "Not installed in this browser yet? Grab the extension below, then reload.";
        }
    }

    function flash(button, ok, label1, label2) {
        const span = button.querySelector("span") || button;
        const before = span.textContent;
        span.textContent = ok ? label1 : label2;
        button.classList.add(ok ? "remote-flash-ok" : "remote-flash-fail");
        button.disabled = true;
        setTimeout(() => {
            span.textContent = before;
            button.classList.remove("remote-flash-ok", "remote-flash-fail");
            button.disabled = false;
        }, 900);
    }

    function sendCommand(command, button) {
        if (!button.disabled) button.disabled = true;
        // The extension's content script relays this into the discord.com tab(s);
        // the ack tells us how many tabs received it.
        const listener = (event) => {
            if (event.source !== window) return;
            const data = event.data;
            if (!data || data.type !== "limeyV1:site:ack" || data.command !== command) return;
            window.removeEventListener("message", listener);
            clearTimeout(timeout);
            button.disabled = false;
            flash(button, data.contacted > 0, "done ✓", "open Discord");
        };
        const timeout = setTimeout(() => {
            window.removeEventListener("message", listener);
            button.disabled = false;
            flash(button, false, "", "no app");
            if (hintEl) hintEl.textContent = "No discord.com tab responded. Open it, then try again.";
        }, 4000);

        window.addEventListener("message", listener);
        window.postMessage({ type: "limeyV1:site", action: "command", command }, "*");
    }

    // .."tries": keep pinging for a while — content scripts settle after install/reload.
    // After the first burst fails we don't give up permanently: the Discord tab
    // (and its Limey runtime) can still be booting, so retry on a slow cadence
    // until a pong lands. Only re-announce the hint after the first burst.
    let announced = false;
    function onPong(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== "limeyV1:site:pong") return;
        window.removeEventListener("message", onPong);
        connected = true;
        setStatus("connected", data.version);
        buttons.forEach(b => { b.disabled = false; });
    }

    function tryPing(attemptsLeft) {
        window.removeEventListener("message", onPong);
        window.addEventListener("message", onPong);
        window.postMessage({ type: "limeyV1:site", action: "ping" }, "*");

        setTimeout(() => {
            if (connected) return;
            if (attemptsLeft > 0) tryPing(attemptsLeft - 1);
            else {
                if (!announced) {
                    announced = true;
                    setStatus("searching");
                }
                // Slow background retries: 1 ping / 4s. Cheap (no network), and
                // picks up the extension once the app tab finishes loading.
                setTimeout(() => { if (!connected) tryPing(6); }, 4000);
            }
        }, 900);
    }

    buttons.forEach(button => {
        button.disabled = true;
        button.addEventListener("click", () => {
            sendCommand(button.getAttribute("data-command"), button);
        });
    });

    if (connectBtn) {
        connectBtn.addEventListener("click", () => {
            if (!connected) { tryPing(6); return; }
            sendCommand("APP_FOCUS", connectBtn);
        });
    }

    tryPing(6);
})();

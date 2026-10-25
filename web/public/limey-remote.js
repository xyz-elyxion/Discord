/*
 * Limey site remote — the website tries to talk to Limey V1 ("the app").
 *
 * Two paths, tried in order:
 *  1. Extension relay (best): the Limey browser extension answers pings on
 *     this page's own origin and relays whitelisted commands into any open
 *     discord.com tab through its background worker. No popups needed.
 *  2. Direct app tab (userscript): if no extension answers, we open (or
 *     reuse) a discord.com/app popup — allowed because it happens inside a
 *     user-gesture click — and cross-origin postMessage the PING/COMMAND
 *     protocol straight into that window. The Limey userscript running in
 *     the app tab answers in the same window target (pong / ack), so the
 *     opener receives it without any extension hop.
 * Everything is best-effort: with neither installed the widget simply stays
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
    let appWin = null; // direct path target (userscript mode)
    const DISCORD_APP_URL = "https://discord.com/app";
    let commandsAllowed = [
        "TOGGLE_MUTE", "TOGGLE_DEAFEN", "TOGGLE_VOICE_MODE",
        "TOGGLE_STREAMER_MODE", "TOGGLE_GO_LIVE_STREAMING", "SAVE_CLIP",
        "NAVIGATE_BACK", "NAVIGATE_FORWARD"
    ];

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

        // Direct path first when we have a live app window (userscript mode).
        if (connected && appWin && !appWin.closed) {
            const listener = (event) => {
                if (event.source !== appWin) return;
                const data = event.data;
                if (!data || data.type !== "limeyV1:remote:ack" || data.command !== command) return;
                window.removeEventListener("message", listener);
                clearTimeout(timeout);
                button.disabled = false;
                flash(button, data.ok === true, "done ✓", "not available");
            };
            const timeout = setTimeout(() => {
                window.removeEventListener("message", listener);
                button.disabled = false;
                flash(button, false, "", "no app");
                if (hintEl) hintEl.textContent = "The app tab didn't respond — is Limey V1 loaded in it?";
            }, 4000);
            window.addEventListener("message", listener);
            appWin.postMessage({ type: "limeyV1:remote:command", command }, "*");
            return;
        }

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
            flash(button, false, "", "open Discord");
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
        const data = event.data;
        if (!data) return;

        // Extension path: answer comes from this page's own window.
        if (data.type === "limeyV1:site:pong" && event.source === window) {
            window.removeEventListener("message", onPong);
            connected = true;
            appWin = null;
            if (Array.isArray(data.commands)) commandsAllowed = data.commands;
            setStatus("connected", data.version);
            buttons.forEach(b => { b.disabled = commandsAllowed.indexOf(b.getAttribute("data-command")) === -1; });
            return;
        }

        // Direct path: answer comes from the opened app tab.
        if (data.type === "limeyV1:remote:pong" && appWin && event.source === appWin) {
            window.removeEventListener("message", onPong);
            connected = true;
            if (Array.isArray(data.commands)) commandsAllowed = data.commands;
            setStatus("connected", data.version);
            buttons.forEach(b => { b.disabled = commandsAllowed.indexOf(b.getAttribute("data-command")) === -1; });
        }
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

    // Direct userscript path: needs a user gesture to open a popup window.
    function connectDirect() {
        if (appWin && !appWin.closed) {
            tryPingDirect();
            return;
        }
        appWin = window.open(DISCORD_APP_URL, "limey-app", "width=1280,height=800");
        if (!appWin) {
            if (hintEl) hintEl.textContent = "Popup blocked — allow popups for this site and try again.";
            return;
        }
        if (hintEl) hintEl.textContent = "Opened the app tab — waiting for Limey V1 to boot…";
        // Give the tab time to load before the first cross-origin ping burst.
        setTimeout(() => tryPingDirect(6), 2500);
    }

    function tryPingDirect(attemptsLeft = 6) {
        if (!appWin || appWin.closed) {
            appWin = null;
            return;
        }
        if (connected) return;
        window.removeEventListener("message", onPong);
        window.addEventListener("message", onPong);
        appWin.postMessage({ type: "limeyV1:remote:ping" }, "*");

        setTimeout(() => {
            if (connected) return;
            if (attemptsLeft > 0) tryPingDirect(attemptsLeft - 1);
            else if (hintEl) hintEl.textContent = "App tab is open but didn't answer. Is the Limey userscript installed in this browser?";
        }, 1200);
    }

    buttons.forEach(button => {
        button.disabled = true;
        button.addEventListener("click", () => {
            sendCommand(button.getAttribute("data-command"), button);
        });
    });

    if (connectBtn) {
        connectBtn.addEventListener("click", () => {
            if (!connected) { connectDirect(); return; }
            // Direct path: just focus the app tab; extension path: APP_FOCUS.
            if (appWin && !appWin.closed) { appWin.focus(); flash(connectBtn, true, "popped up ✓", ""); return; }
            sendCommand("APP_FOCUS", connectBtn);
        });
    }

    tryPing(6);
})();

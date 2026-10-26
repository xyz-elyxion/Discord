/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

"use strict";

const api = window.limebot;
const el = id => document.getElementById(id);

const ui = {
    status: el("status"),
    statusText: el("status-text"),
    uptime: el("uptime"),

    notice: el("node-notice"),
    nodeTitle: el("node-title"),
    nodeDetail: el("node-detail"),
    nodeRecheck: el("node-recheck"),
    nodeDownload: el("node-download"),

    token: el("token"),
    toggleToken: el("toggle-token"),
    openPortal: el("open-portal"),

    start: el("start"),
    stop: el("stop"),
    restart: el("restart"),
    error: el("error"),

    log: el("log"),
    lineCount: el("line-count"),
    copy: el("copy"),
    clear: el("clear"),
    openLogs: el("open-logs"),

    folder: el("folder"),
    changeDir: el("change-dir"),
    resetDir: el("reset-dir")
};

const STATUS_LABELS = {
    stopped: "Stopped",
    starting: "Starting…",
    running: "Running",
    stopping: "Stopping…",
    crashed: "Stopped unexpectedly"
};

const MAX_LINES = 3000;

let state = null;
let lines = 0;

function formatClock(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

function formatUptime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = value => String(value).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function showError(message) {
    if (!message) {
        ui.error.hidden = true;
        ui.error.textContent = "";
        return;
    }
    ui.error.hidden = false;
    ui.error.textContent = message;
}

function updateLineCount() {
    ui.lineCount.textContent = lines ? `${lines} line${lines === 1 ? "" : "s"}` : "";
}

function appendLog(entry) {
    const placeholder = ui.log.querySelector(".log-empty");
    if (placeholder) placeholder.remove();

    const atBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 48;

    const line = document.createElement("span");
    line.className = `log-line ${entry.stream}`;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatClock(entry.at);

    line.append(time, document.createTextNode(entry.line));
    ui.log.append(line);

    while (ui.log.childElementCount > MAX_LINES) ui.log.firstElementChild?.remove();

    lines += 1;
    updateLineCount();

    if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

function clearLog() {
    ui.log.replaceChildren();
    lines = 0;
    updateLineCount();
}

function applyState(next) {
    state = { ...state, ...next };

    const status = state.state ?? "stopped";
    ui.status.dataset.state = status;
    ui.statusText.textContent = STATUS_LABELS[status] ?? status;

    const nodeReady = Boolean(state.node?.ok);
    const busy = status === "starting" || status === "running" || status === "stopping";

    if (!nodeReady && state.node) {
        ui.notice.hidden = false;
        ui.nodeTitle.textContent = "Node.js is needed before the bot can start";
        ui.nodeDetail.textContent = state.node.error ?? "Install Node.js 20 or newer, then press “Check again”.";
    } else {
        ui.notice.hidden = true;
    }

    ui.start.disabled = busy || !nodeReady || !ui.token.value.trim();
    ui.stop.disabled = status === "stopped" || status === "crashed" || status === "stopping";
    ui.restart.disabled = status !== "running" && status !== "starting";

    if (state.token !== undefined && document.activeElement !== ui.token) {
        ui.token.value = state.token;
        ui.start.disabled = busy || !nodeReady || !ui.token.value.trim();
    }

    if (state.botDir) {
        ui.folder.textContent = `Bot folder: ${state.botDir}${state.managed ? " (bundled copy)" : ""}`;
        ui.folder.title = state.botDir;
        ui.resetDir.hidden = !state.managed;
    }

    tickUptime();
}

function tickUptime() {
    if (!state?.startedAt || (state.state !== "running" && state.state !== "starting")) {
        ui.uptime.textContent = "";
        return;
    }
    ui.uptime.textContent = `· ${formatUptime(Date.now() - state.startedAt)}`;
}

// --- controls ---------------------------------------------------------------

ui.token.addEventListener("input", () => {
    const ready = Boolean(state?.node?.ok);
    const busy = state?.state === "starting" || state?.state === "running" || state?.state === "stopping";
    ui.start.disabled = busy || !ready || !ui.token.value.trim();
    showError(null);
});

ui.token.addEventListener("keydown", event => {
    if (event.key === "Enter" && !ui.start.disabled) ui.start.click();
});

// Keep a pasted token even if the volunteer closes the window before starting.
ui.token.addEventListener("change", async () => {
    if (!ui.token.value.trim()) return;
    applyState(await api.saveToken(ui.token.value));
});

ui.toggleToken.addEventListener("click", () => {
    const hidden = ui.token.type === "password";
    ui.token.type = hidden ? "text" : "password";
    ui.toggleToken.textContent = hidden ? "Hide" : "Show";
});

ui.openPortal.addEventListener("click", () => api.openExternal("https://discord.com/developers/applications"));
ui.nodeDownload.addEventListener("click", () => api.openExternal("https://nodejs.org/"));

ui.start.addEventListener("click", async () => {
    showError(null);
    ui.start.disabled = true;
    const result = await api.start(ui.token.value);
    applyState(result);
    showError(result.error);
});

ui.stop.addEventListener("click", async () => {
    applyState(await api.stop());
});

ui.restart.addEventListener("click", async () => {
    showError(null);
    const result = await api.restart();
    applyState(result);
    showError(result.error);
});

ui.copy.addEventListener("click", async () => {
    const text = ui.log.textContent ?? "";
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
    const label = ui.copy.textContent;
    ui.copy.textContent = "Copied";
    setTimeout(() => { ui.copy.textContent = label; }, 1200);
});

ui.clear.addEventListener("click", clearLog);
ui.openLogs.addEventListener("click", () => api.openLogs());

ui.changeDir.addEventListener("click", async () => {
    if (state?.state === "running" || state?.state === "starting") {
        showError("Stop the bot before changing its folder.");
        return;
    }
    applyState(await api.chooseDir());
});

ui.resetDir.addEventListener("click", async () => applyState(await api.resetDir()));

ui.nodeRecheck.addEventListener("click", async () => applyState(await api.recheckNode()));

// --- boot -------------------------------------------------------------------

(async () => {
    api.onLog(appendLog);
    api.onState(next => applyState(next));

    const initial = await api.state();
    applyState(initial);

    for (const entry of await api.logs()) appendLog(entry);

    ui.log.scrollTop = ui.log.scrollHeight;
    setInterval(tickUptime, 1000);
})();

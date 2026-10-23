/*
 * Limey V1 Ghost Client — overlay renderer.
 * Polls the Limey V1 relay for plugin state and renders the GUI here, in the
 * EXE window floating above Discord. Visual plugin effects (crown etc.) are
 * drawn in this overlay instead of inside the Discord client.
 */
"use strict";

const { ipcRenderer } = require("electron");

const $ = id => document.getElementById(id);

const REST_BASE = localStorage.getItem("ghost-relay-base") || "https://limey-discord.onrender.com";
const STATE_KEY = "ghost-client-user-id";
const PING_MS = 10000;

let connectedUserId = "";
let timer = null;

/* ---------- visual flag renderers (Prestige-style cosmetics) ----------
 * Each entry draws the GUI for one relay flag inside the overlay only. */
const FLAG_RENDERERS = {
    crown: {
        label: "Force Owner Crown",
        note: "drawn ESP-style at the owner's spot in Discord (🎯)",
        render(box) {
            box.insertAdjacentHTML("beforeend",
                '<div class="effect"><span class="crown-float">👑</span></div>');
        }
    },
    ranks: { label: "Friendship Ranks", note: "rank ladder rendered here", render(box) { box.insertAdjacentHTML("beforeend", effectRow("🏅", this)); } },
    streak: { label: "Streaks", note: "streak flames rendered here", render(box) { box.insertAdjacentHTML("beforeend", effectRow("🔥", this)); } },
    wiggly: { label: "Wiggly Text", note: "wiggly previews rendered here", render(box) { box.insertAdjacentHTML("beforeend", effectRow("〰️", this)); } },
    timer: { label: "Call Timer", note: "timer rendered here", render(box) { box.insertAdjacentHTML("beforeend", effectRow("⏱️", this)); } },
};

function effectRow(icon, renderer) {
    return `<div class="effect">
        <span class="icon">${icon}</span>
        <span class="name">${renderer.label}</span>
        <span class="badge">ghost overlay</span>
    </div>`;
}

function renderFlags(flags) {
    const box = $("effects");
    box.innerHTML = "";
    if (flags.crown) FLAG_RENDERERS.crown.render(box); // the star of the show gets the floating crown
    for (const [flag, renderer] of Object.entries(FLAG_RENDERERS)) {
        if (flag !== "crown" && flags[flag]) renderer.render(box);
    }
    const any = Object.values(flags).some(Boolean);
    $("effects-panel").classList.toggle("hidden", !any);
}

function renderOffline(msg) {
    $("conn-dot").classList.remove("on");
    $("offline").textContent = msg;
}

function renderState(state) {
    $("conn-dot").classList.add("on");
    $("offline").textContent = `Ghost Client running — paired with ${state.displayName || state.username}`;
    renderFlags(state.flags || {});
    const list = $("plugins");
    list.innerHTML = "";
    for (const name of state.enabledPlugins || []) {
        const li = document.createElement("li");
        li.textContent = name;
        list.append(li);
    }
    const count = (state.enabledPlugins || []).length;
    $("plugin-count").textContent = count ? `(${count})` : "";
    $("plugins-panel").classList.remove("hidden");
}

async function fetchState() {
    if (!connectedUserId) return;
    try {
        const res = await fetch(`${REST_BASE}/v1/ghost/beacon`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: connectedUserId })
        });
        if (!res.ok) return renderOffline("Relay error (" + res.status + ")");
        const state = await res.json();
        if (state.session === null) {
            renderOffline("Ghost Client waiting for Limey V1 in Discord…");
            forwardEspState(state);
            return;
        }
        renderState(state);
        forwardEspState(state);
    } catch {
        renderOffline("Cannot reach the Limey V1 relay — check your connection.");
    }
}

function forwardEspState(state) {
    // Main process relays this to the ESP canvas window (it draws the effects
    // pinned over the Discord window at their live measured positions).
    ipcRenderer.send("ghost-state", {
        paired: state.session !== null,
        flags: state.flags || {},
        anchors: state.anchors || [],
        viewport: state.viewport || null,
    });
}

function pair() {
    const id = $("user-id").value.trim();
    if (!/^\d{5,25}$/.test(id)) {
        $("pair-hint").textContent = "That doesn't look like a Discord user ID.";
        return;
    }
    connectedUserId = id;
    localStorage.setItem(STATE_KEY, id);
    $("pair-hint").textContent = `Paired with user ${id}. The overlay renders your enabled plugin GUI while Limey V1 stays installed in Discord.`;
    void fetchState();
    clearInterval(timer);
    timer = setInterval(fetchState, PING_MS);
}

$("pair-btn").addEventListener("click", pair);
$("user-id").addEventListener("keydown", e => { if (e.key === "Enter") pair(); });

// ---- ESP mode ------------------------------------------------------------
// 🎯 pins a transparent click-through canvas onto the Discord window and draws
// the crown (and friends) at the live positions the plugin measures in the
// Discord UI — exactly like game ESP, but screenshare-proof: it is drawn by
// the EXE's own window, so it never appears in Discord's own screen share.
const espBtn = $("esp-btn");

function setEspUi(on, reason) {
    espBtn.textContent = on ? "🎯" : "🎯";
    espBtn.style.color = on ? "var(--lime)" : "";
    espBtn.title = on
        ? "ESP is ON — the crown is drawn over the owner's row in Discord (Shift+F11 to stop)"
        : `ESP mode (Shift+F11): draw the crown at its exact spot in the member list (Windows)${reason ? " — " + reason : ""}`;
}

espBtn.addEventListener("click", () => {
    ipcRenderer.invoke("esp-toggle").then(on => setEspUi(on));
});
ipcRenderer.on("esp-status", (_e, status) => setEspUi(Boolean(status?.on), status?.reason));

ipcRenderer.on("click-through-set", (_e, on) => {
    $("lock-btn").textContent = on ? "🔓" : "🔒";
});

$("lock-btn").addEventListener("click", () => {
    // With click-through on, this button is unreachable by mouse on purpose:
    // Shift+F10 (or the tray menu) toggles back.
    ipcRenderer.send("set-click-through", true);
});
$("hide-btn").addEventListener("click", () => {
    // Can't hide ourselves via renderer (window handles the shortcut), so
    // just ask main to minimize the trust: awareness only.
    ipcRenderer.send("set-click-through", false);
});
$("quit-btn").addEventListener("click", () => ipcRenderer.send("quit-app"));

try {
    const saved = localStorage.getItem(STATE_KEY);
    if (saved) {
        $("user-id").value = saved;
        pair();
    }
} catch { /* first run */ }

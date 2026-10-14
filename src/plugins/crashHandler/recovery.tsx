/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { onPluginStartFailure, pluginRequiresRestart, plugins as Plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { onceReady } from "@webpack";
import { createRoot, React } from "@webpack/common";
import gitHash from "~git-hash";

import { Logger } from "@utils/Logger";
import { copyToClipboard } from "@utils/clipboard";
import { setLimeyDisabled } from "@utils/limeySwitch";
import { relaunch } from "@utils/native";

const logger = new Logger("CrashRecovery");

/*
 * Recovery Mode: crash-loop protection, last-known-good plugin snapshots, plugin quarantine,
 * diagnostics, and the recovery screen that opens over Discord's crash screen
 * ("Well, this is awkward..."). The screen mimics Windows 11's Recovery (blue backdrop,
 * "Recovery" window, numbered options, keyboard selection). Everything persists in the local
 * DataStore only — recovery is fully offline, and nothing is ever uploaded or shared
 * automatically (see buildReport and the Privacy & Report option).
 */

const STORE_CRASHES = "vc-crash-recovery-crashes";
const STORE_HISTORY = "vc-crash-recovery-history";
const STORE_LAST_GOOD = "vc-crash-recovery-last-good";
const STORE_QUARANTINE = "vc-crash-recovery-quarantine";
const STORE_SESSIONS = "vc-crash-recovery-sessions";

export interface CrashRecord {
    time: number;
    kind: "react-crash" | "startup-failure";
    message: string;
    plugin?: string;
}

export interface RecoveryEvent {
    id: string;
    time: number;
    type: "crash" | "auto-recovery" | "quarantined" | "restored" | "repair" | "startup-ok" | "startup-failed";
    detail: string;
}

interface LastKnownGood {
    time: number;
    gitHash: string;
    plugins: Record<string, boolean>;
}

interface QuarantineEntry {
    originalEnabled: boolean;
    time: number;
    reason: string;
}

interface SessionRecord {
    time: number;
    ok: boolean;
    crashCount: number;
    failures: string[];
}

export interface DependencyReport {
    ok: boolean;
    entries: string[];
}

/* ---------------------------------------- mutable state --------------------------------------- */

let crashes: CrashRecord[] = [];
let history: RecoveryEvent[] = [];
let lastGood: LastKnownGood | undefined;
let quarantine: Record<string, QuarantineEntry> = {};

let sessionStart = Date.now();
let crashesCount = 0;
let sessionFailures: Array<{ plugin: string; error: string; stage: string | null; time: number }> = [];
let lastCrashMessage: string | undefined;
let verdictScheduled = false;
let unregisterFailureListener: (() => void) | null = null;
let initDone = false;
let recentFailedSessions: SessionRecord[] = [];

/* ---------------------------------------- async store ----------------------------------------- */

async function loadStates() {
    crashes = (await DataStore.get<CrashRecord[]>(STORE_CRASHES)) ?? [];
    history = (await DataStore.get<RecoveryEvent[]>(STORE_HISTORY)) ?? [];
    lastGood = await DataStore.get<LastKnownGood>(STORE_LAST_GOOD);
    quarantine = (await DataStore.get<Record<string, QuarantineEntry>>(STORE_QUARANTINE)) ?? {};
    const sessions = (await DataStore.get<SessionRecord[]>(STORE_SESSIONS)) ?? [];
    recentFailedSessions = sessions
        .filter(s => Date.now() - s.time < 1000 * 60 * 60 * 24 * 7)
        .slice(-10);
}

function makeEvent(type: RecoveryEvent["type"], detail: string): RecoveryEvent {
    return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, time: Date.now(), type, detail };
}

async function pushCrash(record: CrashRecord) {
    crashes = [...crashes, record].slice(-100);
    await DataStore.set(STORE_CRASHES, crashes);
}

async function pushHistory(event: RecoveryEvent) {
    history = [...history, event].slice(-50);
    await DataStore.set(STORE_HISTORY, history);
}

export function getHistory() {
    return history.slice();
}

export function getQuarantine() {
    return { ...quarantine };
}

export function isPluginQuarantined(name: string) {
    return quarantine[name] != null;
}

export function getLastKnownGood() {
    return lastGood;
}

/* --------------------------------------- quarantine ------------------------------------------ */

function isPluginToggleable(name: string) {
    const p = Plugins[name];
    return p != null && !p.required && !p.isDependency;
}

export function quarantinePlugin(name: string, reason: string) {
    const p = Plugins[name];
    if (!p || !isPluginToggleable(name)) return false;

    const entry: QuarantineEntry = {
        originalEnabled: !!Settings.plugins[name]?.enabled,
        time: Date.now(),
        reason
    };
    quarantine = { ...quarantine, [name]: entry };
    void DataStore.set(STORE_QUARANTINE, quarantine);

    if (Settings.plugins[name]) Settings.plugins[name].enabled = false;
    try {
        if (p.started) stopPlugin(p);
    } catch { }

    void pushHistory(makeEvent("quarantined", `${name} — ${reason}`));
    return true;
}

export function unquarantinePlugin(name: string) {
    const entry = quarantine[name];
    if (!entry) return false;

    const next = { ...quarantine };
    delete next[name];
    quarantine = next;
    void DataStore.set(STORE_QUARANTINE, quarantine);

    if (entry.originalEnabled) {
        Settings.plugins[name] ??= { enabled: true };
        Settings.plugins[name].enabled = true;
        const p = Plugins[name];
        // Only restart immediately for runtime-only plugins; patched ones need a reload anyway.
        if (p && !p.started && !pluginRequiresRestart(p)) {
            try { startPlugin(p); } catch { }
        }
    }
    void pushHistory(makeEvent("restored", `${name} (was ${entry.originalEnabled ? "enabled" : "disabled"})`));
    return true;
}

/* ------------------------------------ last known good ---------------------------------------- */

export function saveLastKnownGood() {
    if (crashesCount > 0 || sessionFailures.length > 0) return false;

    const plugins: Record<string, boolean> = {};
    for (const p of Object.values(Plugins)) {
        plugins[p.name] = p.required || p.isDependency || !!Settings.plugins[p.name]?.enabled;
    }
    lastGood = { time: Date.now(), gitHash, plugins };
    void DataStore.set(STORE_LAST_GOOD, lastGood);
    return true;
}

export async function restoreLastKnownGood() {
    if (!lastGood) return false;

    for (const [name, wasEnabled] of Object.entries(lastGood.plugins)) {
        if (!isPluginToggleable(name) || !Settings.plugins[name]) continue;
        const p = Plugins[name];
        const now = p.started;
        if (now !== wasEnabled) {
            Settings.plugins[name].enabled = wasEnabled;
            if (wasEnabled && !now && !pluginRequiresRestart(p)) {
                try { startPlugin(p); } catch { }
            }
        }
    }
    await pushHistory(makeEvent("restored", "Restored Last Known Good configuration"));
    return true;
}

/* --------------------------- one-click repair (recommendations) ------------------------------ */

export async function buildRepairPlan(): Promise<string[]> {
    const plan: string[] = [];
    const suspects = await suspectList();

    if (crashesCount > 0) {
        plan.push(`This session recorded ${crashesCount} crash${crashesCount === 1 ? "" : "es"}${lastCrashMessage ? ` — last: ${lastCrashMessage}` : ""}.`);
    }
    if (sessionFailures.length) {
        plan.push(`Quarantine the plugin(s) that failed to start this session: ${[...new Set(sessionFailures.map(f => f.plugin))].join(", ")}.`);
    }
    const unknown = suspects.filter(s => !sessionFailures.some(f => f.plugin === s));
    if (unknown.length) {
        plan.push(`Quarantine plugin(s) newly enabled since the last good session: ${unknown.join(", ")}.`);
    }
    if (!plan.length) {
        if (lastGood) {
            plan.push("No suspects identified — restore the Last Known Good configuration if the crash persists on the next reload.");
        } else {
            plan.push("No diagnostics available yet. After a successful session, your plugin configuration is remembered for repairs.");
        }
    }
    return plan;
}

export async function applyRepairPlan() {
    const applied: string[] = [];
    const suspects = await suspectList();
    for (const name of suspects) {
        if (quarantinePlugin(name, "Recommended fix (suspected of causing this crash)")) {
            applied.push(name);
        }
    }
    await pushHistory(makeEvent("repair", applied.length ? `Quarantined: ${applied.join(", ")}` : "No suspects to quarantine"));
    notifyUiUpdate();
    return applied;
}

async function suspectList(): Promise<string[]> {
    const suspects = new Set<string>();
    for (const f of sessionFailures) suspects.add(f.plugin);
    if (lastGood) {
        const currently = {};
        for (const p of Object.values(Plugins)) {
            currently[p.name] = p.required || p.isDependency || !!Settings.plugins[p.name]?.enabled;
        }
        for (const [name, enabled] of Object.entries(currently)) {
            if (enabled && lastGood.plugins[name] === false) suspects.add(name);
        }
    }
    return [...suspects];
}

/* ------------------------------------- reset limey v1 ----------------------------------------- */

/**
 * Wipes Limey V1 back to a clean slate: every plugin toggle and per-plugin
 * setting is removed (built-in defaults re-apply on the next boot), plugins
 * are un-quarantined and all recovery state is erased.
 *
 * Call relaunch() afterwards to apply the reset.
 */
export async function resetLimeyV1() {
    // Reset plugin configuration (toggles + per-plugin settings)
    for (const name of Object.keys(Settings.plugins)) {
        delete Settings.plugins[name];
    }

    // Clear plugin quarantine and all recovery bookkeeping
    crashes = [];
    history = [];
    lastGood = undefined;
    quarantine = {};
    recentFailedSessions = [];
    await Promise.allSettled([
        DataStore.set(STORE_CRASHES, []),
        DataStore.set(STORE_HISTORY, []),
        DataStore.del(STORE_LAST_GOOD),
        DataStore.set(STORE_QUARANTINE, {}),
        DataStore.set(STORE_SESSIONS, [])
    ]);

    await pushHistory(makeEvent("repair", "Limey V1 was reset (plugin settings back to defaults, recovery state cleared)"));
}

/* ----------------------------------- dependency checker -------------------------------------- */

export interface DependencyCheckResult {
    ok: boolean;
    entries: string[];
}

export async function checkDependencies(): Promise<DependencyCheckResult> {
    const entries: string[] = [];
    for (const p of Object.values(Plugins)) {
        if (!p.required && !p.isDependency && !Settings.plugins[p.name]?.enabled) continue;

        for (const dep of p.dependencies ?? []) {
            if (!Plugins[dep]) {
                entries.push(`${p.name}: missing dependency "${dep}" (does not exist in this build)`);
            } else if (p.started && !(Plugins[dep].required || Plugins[dep].isDependency || Settings.plugins[dep]?.enabled)) {
                entries.push(`${p.name}: dependency "${dep}" is not enabled`);
            }
        }

        if (!p.started && sessionFailures.some(f => f.plugin === p.name)) {
            entries.push(`${p.name}: enabled but failed to start this session (${sessionFailures.find(f => f.plugin === p.name)?.stage ?? "start"})`);
        }
    }
    return { ok: entries.length === 0, entries };
}

/* -------------------------------- session bookkeeping ---------------------------------------- */

async function saveSessionRecord(ok: boolean) {
    const sessions = recentFailedSessions
        .filter(s => Date.now() - s.time < 1000 * 60 * 60 * 24 * 7)
        .slice(-9);
    const record: SessionRecord = {
        time: sessionStart,
        ok,
        crashCount: crashesCount,
        failures: [...new Set(sessionFailures.map(f => f.plugin))]
    };
    await DataStore.set(STORE_SESSIONS, [...sessions.slice(-9), record].slice(-10));
    if (!ok) {
        recentFailedSessions = [...sessions.slice(-9), record].slice(-10);
    }
}

function markSessionFailed() {
    void saveSessionRecord(false).then(() => {
        // Crash Loop Protection: two consecutive bad sessions -> auto-enter recovery
        const lastTwo = recentFailedSessions.slice(-2);
        if (lastTwo.length >= 2 && lastTwo.every(s => !s.ok)) {
            void pushHistory(makeEvent("auto-recovery", "Two consecutive failed sessions — Crash Loop Protection opened Recovery Mode"));
            openRecoveryOverlay("Crash Loop Protection: this session keeps failing (also on last startup). Use One-Click Repair in Troubleshoot, then restart Discord or use Turn off Limey V1.");
        }
    });
}

function scheduleSessionVerdict() {
    if (verdictScheduled) return;
    verdictScheduled = true;
    // Give the app time to prove itself before recording how this session went
    setTimeout(() => {
        verdictScheduled = false;
        if (crashesCount === 0 && sessionFailures.length === 0) {
            void saveSessionRecord(true);
            saveLastKnownGood();
            void pushHistory(makeEvent("startup-ok", `Session launched successfully (${new Date(sessionStart).toLocaleString()})`));
        } else {
            void markSessionFailed();
        }
    }, 45_000);
}

export function handleStartupFailure(name: string, error: unknown, stage: string | null) {
    if (!initDone) {
        logger.warn("Startup failure of", name, "recorded before recovery init; ignoring", error);
        return;
    }
    sessionFailures.push({
        plugin: name,
        error: String((error as Error)?.stack ?? error),
        stage,
        time: Date.now()
    });
    void pushCrash({
        time: Date.now(),
        kind: "startup-failure",
        message: String((error as Error)?.message ?? error),
        plugin: name
    });
    void pushHistory(makeEvent("startup-failed", `${name} (${new Date().toLocaleString()})`));
    scheduleSessionVerdict();
    notifyUiUpdate();

    if (sessionFailures.length >= 3) {
        void pushHistory(makeEvent("auto-recovery", "3+ plugin startup failures this session — Recovery Mode opened automatically"));
        openRecoveryOverlay("Multiple plugins failed during startup. Quarantine them via One-Click Repair, then restart Discord or use Turn off Limey V1.");
    }
}

export function handleRecoverableCrash(errorState: { error?: unknown; info?: unknown; }) {
    crashesCount++;
    if (errorState?.error instanceof Error) {
        lastCrashMessage = errorState.error.message;
    } else if (errorState?.error != null) {
        lastCrashMessage = String(errorState.error);
    }
    void pushCrash({
        time: Date.now(),
        kind: "react-crash",
        message: (errorState?.error as Error)?.message ?? String(errorState?.error ?? "Unknown React crash")
    });
    void pushHistory(makeEvent("crash", lastCrashMessage ?? "Unknown React crash"));
    scheduleSessionVerdict();
    notifyUiUpdate();
}

/* ------------------------------------ diagnostics report -------------------------------------- */

export interface RecoveryReport {
    time: string;
    platform: string;
    buildHash: string;
    crashesThisSession: number;
    lastCrashMessage: string | undefined;
    startFailures: Array<{ plugin: string; error: string }>;
    quarantined: string[];
    lastGood: { time: number; gitHash: string } | null;
}

export async function buildReport(): Promise<RecoveryReport> {
    return {
        time: new Date().toISOString(),
        platform: "web (userscript)",
        buildHash: gitHash,
        crashesThisSession: crashesCount,
        lastCrashMessage,
        startFailures: sessionFailures.map(({ plugin, error }) => ({ plugin, error })),
        quarantined: Object.keys(quarantine),
        lastGood: lastGood ? { time: lastGood.time, gitHash: lastGood.gitHash } : null
    };
}

/* ------------------------------------------------ overlay -------------------------------------- */
/*
 * Win11 Recovery (WinRE) look:
 *   - full-screen blue backdrop
 *   - a floating "Recovery" window with a proper title bar and close button
 *   - numbered option tiles chosen by mouse or keyboard (1..9), Esc goes back / closes
 *   - screens: Choose an option -> Troubleshoot (Advanced options) -> sub-screens for
 *     quarantine, dependency checker, history and the privacy report
 */

const OVERLAY_HOST_ID = "vc-crash-recovery-overlay";
const OVERLAY_STYLE_ID = "vc-crash-recovery-style";

let overlayRoot: null | ReturnType<typeof createRoot> = null;
let overlayOpen = false;
let overlayReason: string | undefined;
const overlayStateListeners = new Set<() => void>();
const uiUpdateListeners = new Set<() => void>();

function mountOverlay() {
    if (overlayRoot || typeof document === "undefined") return;
    if (!document.body) {
        document.addEventListener("DOMContentLoaded", mountOverlay, { once: true });
        return;
    }
    if (!document.getElementById(OVERLAY_STYLE_ID)) {
        const style = document.createElement("style");
        style.id = OVERLAY_STYLE_ID;
        style.textContent = `
#${OVERLAY_HOST_ID},
#${OVERLAY_HOST_ID} * {
    box-sizing: border-box;
}
#${OVERLAY_HOST_ID} .vc-recovery-tile {
    transition: background 80ms ease, border-color 80ms ease;
}
#${OVERLAY_HOST_ID} .vc-recovery-tile:hover {
    background: #eaf2fc;
    border-color: #1265c4;
}
#${OVERLAY_HOST_ID} .vc-recovery-tile:focus-visible {
    outline: 2px solid #1265c4;
    outline-offset: 2px;
}
#${OVERLAY_HOST_ID} .vc-recovery-close:hover {
    background: #c42b1c;
    color: #ffffff;
}
@keyframes vc-recovery-dot {
    0% { opacity: .15; transform: scale(.7); }
    35% { opacity: 1; transform: scale(1); }
    70% { opacity: .15; transform: scale(.7); }
    100% { opacity: .15; transform: scale(.7); }
}
@keyframes vc-recovery-fade-in {
    from { opacity: 0; transform: scale(.97); }
    to { opacity: 1; transform: scale(1); }
}
@keyframes vc-recovery-glow {
    0% { opacity: .5; }
    50% { opacity: 1; }
    100% { opacity: .5; }
}
#${OVERLAY_HOST_ID} .vc-recovery-window {
    animation: vc-recovery-fade-in .28s ease both;
}
`;
        document.head.appendChild(style);
    }
    const container = document.createElement("div");
    container.id = OVERLAY_HOST_ID;
    document.body.appendChild(container);
    overlayRoot = createRoot(container);
    overlayRoot.render(<OverlayRoot />);
}

export function openRecoveryOverlay(reason?: string) {
    if (reason !== undefined) overlayReason = reason;
    mountOverlay();
    overlayOpen = true;
    for (const listener of overlayStateListeners) {
        try { listener(); } catch { }
    }
}

function closeOverlay() {
    overlayOpen = false;
    overlayReason = undefined;
    for (const listener of overlayStateListeners) {
        try { listener(); } catch { }
    }
    // Fully tear down the overlay (and its root element) so nothing — like
    // the old floating "Open Recovery Mode" button — lingers over Discord
    // after Recovery Mode was closed. It can be opened again from
    // Limey V1 Settings or on the next crash.
    unmountOverlay();
}

function notifyUiUpdate() {
    for (const listener of uiUpdateListeners) {
        try { listener(); } catch { }
    }
}

function unmountOverlay() {
    overlayRoot?.unmount();
    overlayRoot = null;
    document.getElementById(OVERLAY_HOST_ID)?.remove();
}

/* ------------------------------------------------ theme ---------------------------------------- */

const WINRE_BLUE = "#1265c4";

const backdropStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 99999,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: `radial-gradient(1100px 700px at 50% 32%, #1a72d2 0%, ${WINRE_BLUE} 55%, #0d4f9e 100%)`,
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
};

const windowStyle: React.CSSProperties = {
    width: 640,
    maxWidth: "94vw",
    maxHeight: "86vh",
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    color: "#1b1b1b",
    borderRadius: 8,
    overflow: "hidden",
    boxShadow: "0 32px 80px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .35)"
};

const titleBarStyle: React.CSSProperties = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 40,
    padding: "0 0 0 12px",
    borderBottom: "1px solid #e6e6e6",
    background: "#f9f9f9"
};

const closeBtnStyle: React.CSSProperties = {
    width: 46,
    height: 40,
    display: "grid",
    placeItems: "center",
    background: "transparent",
    border: "none",
    color: "#262626",
    cursor: "pointer",
    fontSize: 16
};

const contentStyle: React.CSSProperties = {
    flex: 1,
    overflowY: "auto",
    padding: "18px 26px 22px"
};

const headingStyle: React.CSSProperties = {
    margin: "2px 0 4px",
    fontSize: 21,
    fontWeight: 600,
    color: "#191919"
};

const subHeadingStyle: React.CSSProperties = {
    margin: "0 0 14px",
    fontSize: 13.5,
    color: "#5c5c5c",
    lineHeight: 1.45
};

const bannerStyle: React.CSSProperties = {
    margin: "0 0 14px",
    padding: "8px 12px",
    background: "#fff4ce",
    borderLeft: "3px solid #ffb900",
    fontSize: 13,
    color: "#413119",
    lineHeight: 1.4
};

const bannerDangerStyle: React.CSSProperties = {
    ...bannerStyle,
    background: "#fde7e9",
    borderLeftColor: "#c42b1c",
    color: "#5a1a1e"
};

const listStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8
};

const tileStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 14,
    width: "100%",
    padding: "10px 14px",
    background: "#ffffff",
    border: "1px solid #dcdcdc",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    color: "inherit",
    font: "inherit"
};

const iconTileStyle: React.CSSProperties = {
    flexShrink: 0,
    width: 36,
    height: 36,
    display: "grid",
    placeItems: "center",
    borderRadius: 4,
    background: "#eaf2fc",
    color: WINRE_BLUE
};

const tileLabelStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2
};

const tileBodyStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: "#191919"
};

const tileSubStyle: React.CSSProperties = {
    fontSize: 12.5,
    color: "#5c5c5c",
    lineHeight: 1.35
};

const numberBadgeStyle: React.CSSProperties = {
    flexShrink: 0,
    minWidth: 22,
    height: 22,
    padding: "0 6px",
    display: "grid",
    placeItems: "center",
    border: "1px solid #c8c8c8",
    borderRadius: 11,
    fontSize: 11,
    fontWeight: 600,
    color: "#444444"
};

const footerStyle: React.CSSProperties = {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    height: 34,
    padding: "0 14px",
    borderTop: "1px solid #e6e6e6",
    background: "#f3f3f3",
    fontSize: 11.5,
    color: "#5c5c5c"
};

const actionButtonStyle: React.CSSProperties = {
    padding: "6px 14px",
    background: "#ffffff",
    border: "1px solid #c8c8c8",
    borderRadius: 4,
    font: "inherit",
    fontSize: 13,
    color: "#191919",
    cursor: "pointer"
};

const flashStyle: React.CSSProperties = {
    margin: "0 0 12px",
    padding: "8px 12px",
    background: "#f2f8ff",
    borderLeft: "3px solid " + WINRE_BLUE,
    fontSize: 13,
    color: "#1d3a5c",
    lineHeight: 1.4
};

const rowsBoxStyle: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    border: "1px solid #e1e1e1",
    borderRadius: 6,
    padding: "10px 12px",
    maxHeight: 260,
    overflowY: "auto"
};

const rowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 13,
    color: "#333333",
    lineHeight: 1.4
};

const textareaStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 110,
    marginTop: 4,
    fontSize: 11,
    fontFamily: "monospace",
    whiteSpace: "pre",
    resize: "vertical",
    background: "#f6f6f6",
    color: "#333333",
    border: "1px solid #dcdcdc",
    borderRadius: 4,
    padding: 8
};

/* ------------------------------------------- icons --------------------------------------------- */

function WinreIcon({ d, size = 20 }: { d: string; size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={d} />
        </svg>
    );
}

const ICONS = {
    continue: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z",
    wrench: "M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z",
    restart: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    report: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm4 18H6V4h7v5h5v11z",
    shield: "M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z",
    search: "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
    history: "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 7 7v2a9 9 0 1 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
    restore: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
    back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
    lock: "M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9V6z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    power: "M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04",
    delete: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
};

function LimeyLogo({ size = 72 }: { size?: number; }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 100 100"
            fill="none"
            aria-hidden="true"
        >
            {/* lime wheel: rind, pith, flesh and segment spokes */}
            <circle cx="50" cy="50" r="30" fill="#f2fbe8" />
            <circle cx="50" cy="50" r="23" fill="#a3e635" />
            {[0, 60, 120, 180, 240, 300].map(deg => (
                <line
                    key={deg}
                    x1="50"
                    y1="50"
                    x2="50"
                    y2="20"
                    stroke="#f2fbe8"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    transform={`rotate(${deg + 12} 50 50)`}
                />
            ))}
            <circle cx="50" cy="50" r="3" fill="#f2fbe8" />
        </svg>
    );
}

const BOOT_DURATION_MS = 2_000;

const splashSpinnerStyle: React.CSSProperties = {
    position: "relative",
    width: 64,
    height: 64
};

/** WinRE-style boot splash: Windows logo + spinning dots + status line */
function BootSplash() {
    return (
        <div style={{ ...backdropStyle, flexDirection: "column", gap: 30 }}>
            <div style={{ animation: "vc-recovery-glow 2s ease-in-out infinite" }}>
                <LimeyLogo />
            </div>
            <div style={splashSpinnerStyle} aria-label="Loading">
                {[0, 1, 2, 3, 4, 5].map(i => (
                    <div
                        key={i}
                        style={{
                            position: "absolute",
                            top: "50%",
                            left: "50%",
                            width: 8,
                            height: 8,
                            marginLeft: -4,
                            marginTop: -4,
                            borderRadius: 4,
                            background: "#ffffff",
                            transform: `rotate(${i * 60}deg) translateY(-24px)`,
                            animation: `vc-recovery-dot 1.2s linear ${-(i * 0.2)}s infinite`
                        }}
                    />
                ))}
            </div>
            <div style={{
                color: "rgba(255, 255, 255, .92)",
                fontSize: 15,
                letterSpacing: ".2px"
            }}>
                Preparing Recovery Mode…
            </div>
        </div>
    );
}

/* ------------------------------------------- screens -------------------------------------------- */

type WinreScreen = "choose" | "troubleshoot" | "quarantine" | "dependency" | "history" | "report";

interface WinreOption {
    icon: string;
    label: string;
    sublabel?: string;
    action: () => void;
}

function sessionSummary() {
    const failures = [...new Set(sessionFailures.map(f => f.plugin))];
    const parts: string[] = [];
    parts.push(crashesCount === 0 ? "No crashes this session" : `${crashesCount} crash(es) this session${lastCrashMessage ? ` — last: ${lastCrashMessage}` : ""}`);
    parts.push(failures.length ? `Startup failures: ${failures.join(", ")}` : "All enabled plugins started");
    const quarantinedNames = Object.keys(quarantine);
    if (quarantinedNames.length) parts.push(`Quarantined: ${quarantinedNames.join(", ")}`);
    return parts.join(" · ");
}

function useWinreNumberKeys(options: WinreOption[], onBack?: () => void) {
    React.useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onBack?.();
                return;
            }
            const n = Number(e.key);
            if (!Number.isInteger(n) || n < 1 || n > Math.min(options.length, 9)) return;
            e.preventDefault();
            options[n - 1].action();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    });
}

function WinreTile({ index, option }: { index: number; option: WinreOption; }) {
    return (
        <div
            role="button"
            tabIndex={0}
            className="vc-recovery-tile"
            style={tileStyle}
            onClick={() => option.action()}
            onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    option.action();
                }
            }}
        >
            <div style={iconTileStyle}>
                <WinreIcon d={option.icon} />
            </div>
            <div style={tileLabelStyle}>
                <div style={tileBodyStyle}>{option.label}</div>
                {option.sublabel && <div style={tileSubStyle}>{option.sublabel}</div>}
            </div>
            <div style={numberBadgeStyle}>{index + 1}</div>
        </div>
    );
}

function WinreHeading({ title, sub }: { title: string; sub?: string; }) {
    return (
        <>
            <h2 style={headingStyle}>{title}</h2>
            {sub && <p style={subHeadingStyle}>{sub}</p>}
        </>
    );
}

function WinreFlash({ text, danger }: { text: string; danger?: boolean; }) {
    return <p style={danger ? bannerDangerStyle : flashStyle}>{text}</p>;
}

function ChooseScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const options: WinreOption[] = [
        {
            icon: ICONS.continue,
            label: "Continue",
            sublabel: "Close Recovery Mode and return to Discord",
            action: () => closeOverlay()
        },
        {
            icon: ICONS.wrench,
            label: "Troubleshoot",
            sublabel: "Advanced options — repair, restore, quarantine and diagnostics",
            action: () => open("troubleshoot")
        },
        {
            icon: ICONS.power,
            label: "Turn off Limey V1",
            sublabel: "Turn off all Limey V1 plugins, patches and styles until you turn it back on from the notice it shows at startup",
            action: () => {
                setLimeyDisabled(true);
                void relaunch();
            }
        },
        {
            icon: ICONS.report,
            label: "Diagnostics & Report",
            sublabel: "Review what went wrong this session; the report is yours to copy, never ours to send",
            action: () => open("report")
        }
    ];

    useWinreNumberKeys(options, closeOverlay);

    return (
        <>
            <WinreHeading title="Choose an option" sub={sessionSummary()} />
            {overlayReason && <p style={bannerStyle}>{overlayReason}</p>}
            <div style={listStyle}>
                {options.map((o, i) => <WinreTile key={o.label} index={i} option={o} />)}
            </div>
        </>
    );
}

function TroubleshootScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const [flash, setFlash] = React.useState<string | null>(null);
    const lastGoodEntry = getLastKnownGood();

    const options: WinreOption[] = [
        {
            icon: ICONS.wrench,
            label: "One-Click Repair",
            sublabel: "Automatically quarantine the plugins suspected of causing crashes",
            action: async () => {
                const applied = await applyRepairPlan();
                setFlash(
                    applied.length
                        ? `One-Click Repair quarantined: ${applied.join(", ")}. Restart Discord to apply it fully.`
                        : "One-Click Repair found nothing to quarantine."
                );
            }
        },
        {
            icon: ICONS.restore,
            label: "Restore Last Known Good",
            sublabel: lastGoodEntry
                ? `Revert to the last healthy configuration (saved ${new Date(lastGoodEntry.time).toLocaleString()} on build ${lastGoodEntry.gitHash.slice(0, 7)})`
                : "Revert to your last healthy configuration (none saved yet)",
            action: async () => {
                const ok = await restoreLastKnownGood();
                setFlash(ok
                    ? "Last Known Good configuration restored. Restart Discord if some plugins didn't come back on their own."
                    : "No Last Known Good configuration saved yet — one is taken after a healthy session.");
            }
        },
        {
            icon: ICONS.shield,
            label: "Plugin Quarantine",
            sublabel: "View and restore plugins held out of startup",
            action: () => open("quarantine")
        },
        {
            icon: ICONS.search,
            label: "Dependency Checker",
            sublabel: "Check enabled plugins for missing or disabled dependencies",
            action: () => open("dependency")
        },
        {
            icon: ICONS.history,
            label: "Recovery History",
            sublabel: "See the last 50 recovery events on this device",
            action: () => open("history")
        }
    ];

    useWinreNumberKeys(options, () => open("choose"));

    return (
        <>
            <WinreHeading
                title="Advanced options"
                sub="Repair or roll back the plugin environment, then restart Discord (or use Turn off Limey V1 on the first screen) to apply it."
            />
            {flash && <WinreFlash text={flash} />}
            <div style={listStyle}>
                {options.map((o, i) => <WinreTile key={o.label} index={i} option={o} />)}
            </div>
            <BackTile onBack={() => open("choose")} />
        </>
    );
}

function QuarantineScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const [entries, setEntries] = React.useState<Record<string, QuarantineEntry>>(() => getQuarantine());

    React.useEffect(() => {
        const listener = () => setEntries(getQuarantine());
        uiUpdateListeners.add(listener);
        return () => { uiUpdateListeners.delete(listener); };
    }, []);

    const names = Object.keys(entries);

    return (
        <>
            <WinreHeading
                title="Plugin Quarantine"
                sub={names.length
                    ? "Quarantined plugins stay disabled until you restore them."
                    : "Nothing is currently quarantined. Plugins end up here via One-Click Repair or startup failures."}
            />
            {names.length > 0 && (
                <div style={rowsBoxStyle}>
                    {names.map(n => (
                        <div key={n} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: names.indexOf(n) ? 6 : 0 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#191919" }}>{n}</div>
                                <div style={{ fontSize: 12, color: "#5c5c5c" }}>{entries[n].reason}</div>
                            </div>
                            <button
                                style={actionButtonStyle}
                                onClick={() => {
                                    unquarantinePlugin(n);
                                    setEntries(getQuarantine());
                                }}
                            >
                                Restore
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <BackTile onBack={() => open("troubleshoot")} />
        </>
    );
}

function DependencyScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const [dep, setDep] = React.useState<DependencyCheckResult | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        checkDependencies().then(d => {
            if (!cancelled) setDep(d);
        });
        return () => { cancelled = true; };
    }, []);

    return (
        <>
            <WinreHeading
                title="Dependency Checker"
                sub="All plugins kept in startup are checked for missing or disabled dependencies."
            />
            {dep == null
                ? <p style={subHeadingStyle}>Checking…</p>
                : dep.ok
                    ? <p style={{ ...flashStyle, borderLeftColor: "#6bb700", background: "#f3fbec", color: "#253b0d" }}>
                        All enabled plugins resolved their dependencies and started.
                    </p>
                    : (
                        <div style={rowsBoxStyle}>
                            {dep.entries.map((e, i) => (
                                <div key={i} style={rowStyle}>• {e}</div>
                            ))}
                        </div>
                    )}
            <BackTile onBack={() => open("troubleshoot")} />
        </>
    );
}

function HistoryScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const [rev, setRev] = React.useState(0);

    React.useEffect(() => {
        const listener = () => setRev(r => r + 1);
        uiUpdateListeners.add(listener);
        return () => { uiUpdateListeners.delete(listener); };
    }, []);

    const events = getHistory().slice(-15).reverse();

    return (
        <>
            <WinreHeading
                title="Recovery History"
                sub="The most recent recovery events (crashes, repairs, quarantines, restores) from the last 50 stored."
            />
            {events.length === 0
                ? <p style={subHeadingStyle}>No events yet.</p>
                : (
                    <div style={rowsBoxStyle}>
                        {events.map(h => (
                            <div key={h.id} style={rowStyle}>
                                <span style={{ color: "#5c5c5c", fontVariantNumeric: "tabular-nums" }}>
                                    [{new Date(h.time).toLocaleString()}]
                                </span>
                                <span><strong>{h.type}</strong> — {h.detail}</span>
                            </div>
                        ))}
                    </div>
                )}
            <BackTile onBack={() => open("troubleshoot")} />
        </>
    );
}

function ReportScreen({ open }: { open: (s: WinreScreen) => void; }) {
    const [reportText, setReportText] = React.useState("");
    const lastGoodEntry = getLastKnownGood();
    const versionMismatch = lastGoodEntry != null && lastGoodEntry.gitHash !== gitHash;
    const failures = [...new Set(sessionFailures.map(f => f.plugin))];

    return (
        <>
            <WinreHeading
                title="Privacy & Diagnostics"
                sub="Diagnostics stay on your device. Nothing is shared automatically — copy the report only if you choose to."
            />
            <div style={{ ...flashStyle, background: "#f6f6f6", color: "#333333", borderLeftColor: "#c8c8c8" }}>
                {crashesCount === 0 ? "No crashes this session." : `${crashesCount} crash(es) this session${lastCrashMessage ? ` — last: ${lastCrashMessage}` : ""}.`}
                {failures.length ? ` Startup failures: ${failures.join(", ")}.` : " All enabled plugins started."}
            </div>
            {lastGoodEntry && versionMismatch && (
                <p style={bannerStyle}>
                    The snapshot from build {lastGoodEntry.gitHash.slice(0, 7)} differs from this build ({gitHash.slice(0, 7)}).
                    If the update itself is what crashes, restore Last Known Good and reinstall the previous Limey V1 build with your installer (Update Rollback).
                </p>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button
                    style={actionButtonStyle}
                    onClick={async () => {
                        setReportText(JSON.stringify(await buildReport(), null, 2));
                    }}
                >
                    Generate Report
                </button>
                {reportText && (
                    <>
                        <button style={actionButtonStyle} onClick={() => void copyToClipboard(reportText)}>
                            Copy
                        </button>
                        <button style={actionButtonStyle} onClick={() => setReportText("")}>
                            Hide
                        </button>
                    </>
                )}
            </div>
            {reportText && <textarea readOnly value={reportText} style={textareaStyle} onFocus={e => e.currentTarget.select()} />}
            <BackTile onBack={() => open("troubleshoot")} />
        </>
    );
}

function BackTile({ onBack }: { onBack: () => void; }) {
    return (
        <div style={{ display: "flex", justifyContent: "flex-start", marginTop: 12 }}>
            <div
                role="button"
                tabIndex={0}
                className="vc-recovery-tile"
                style={{ ...tileStyle, width: "auto", padding: "6px 10px" }}
                onClick={onBack}
                onKeyDown={e => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onBack();
                    }
                }}
            >
                <WinreIcon d={ICONS.back} size={16} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>Back</span>
                <span style={{ ...numberBadgeStyle, marginLeft: 4 }}>Esc</span>
            </div>
        </div>
    );
}

function RecoveryScreen() {
    const [booted, setBooted] = React.useState(false);
    const [screen, setScreen] = React.useState<WinreScreen>("choose");

    // Windows-style boot sequence: spinner splash first, then the menu fades in
    React.useEffect(() => {
        const timer = setTimeout(() => setBooted(true), BOOT_DURATION_MS);
        return () => clearTimeout(timer);
    }, []);

    const titles: Record<WinreScreen, string> = {
        choose: "Choose an option",
        troubleshoot: "Troubleshoot",
        quarantine: "Plugin Quarantine",
        dependency: "Dependency Checker",
        history: "Recovery History",
        report: "Privacy & Diagnostics"
    };

    const escAction = () => {
        if (screen === "choose") closeOverlay();
        else if (screen === "troubleshoot") setScreen("choose");
        else setScreen("troubleshoot");
    };

    const body =
        screen === "choose" ? <ChooseScreen open={s => setScreen(s)} />
            : screen === "troubleshoot" ? <TroubleshootScreen open={s => setScreen(s)} />
                : screen === "quarantine" ? <QuarantineScreen open={s => setScreen(s)} />
                    : screen === "dependency" ? <DependencyScreen open={s => setScreen(s)} />
                        : screen === "history" ? <HistoryScreen open={s => setScreen(s)} />
                            : <ReportScreen open={s => setScreen(s)} />;

    if (!booted) return <BootSplash />;

    return (
        <div style={backdropStyle}>
            <div className="vc-recovery-window" style={windowStyle}>
                <div style={titleBarStyle}>
                    <span style={{ fontSize: 13, color: "#1b1b1b" }}>Recovery</span>
                    <button
                        aria-label="Close Recovery Mode"
                        className="vc-recovery-close"
                        style={closeBtnStyle}
                        onClick={closeOverlay}
                    >
                        <WinreIcon d={ICONS.close} size={12} />
                    </button>
                </div>
                <div style={contentStyle}>{body}</div>
                <div style={footerStyle}>
                    <span>Recovery Mode — Limey V1{screen !== "choose" ? ` › ${titles[screen]}` : ""}</span>
                    <span>Pick an option with the mouse, or press its number 1–9 · Esc goes back</span>
                </div>
            </div>
        </div>
    );
}

const RecoveryScreenWrapped = ErrorBoundary.wrap(RecoveryScreen, { noop: true });

function OverlayRoot() {
    const [open, setOpen] = React.useState(overlayOpen);

    React.useEffect(() => {
        const listener = () => setOpen(overlayOpen);
        overlayStateListeners.add(listener);
        return () => { overlayStateListeners.delete(listener); };
    }, []);

    if (open) return <RecoveryScreenWrapped />;

    return null;
}

/* -------------------------------------- init / cleanup --------------------------------------- */

export function initRecovery() {
    if (initDone) return;
    initDone = true;
    sessionStart = Date.now();
    crashesCount = 0;
    sessionFailures = [];
    lastCrashMessage = undefined;

    loadStates()
        .then(() => {
            unregisterFailureListener = onPluginStartFailure(handleStartupFailure);
            // Snapshot Last Known Good shortly after the app is fully up (if this session is healthy)
            void onceReady.then(() => {
                setTimeout(() => {
                    if (crashesCount > 0 || sessionFailures.length > 0) {
                        logger.info("Skipping Last Known Good snapshot: session is not clean");
                    } else {
                        saveLastKnownGood();
                    }
                }, 2000);
            });
        })
        .catch(e => logger.error("Failed to initialize recovery state", e));

    scheduleSessionVerdict();
}

export function cleanupRecovery() {
    unregisterFailureListener?.();
    unregisterFailureListener = null;
    unmountOverlay();
    initDone = false;
}

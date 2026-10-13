/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { onPluginStartFailure, pluginRequiresRestart, plugins as Plugins, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { onceReady } from "@webpack";
import { createRoot, React } from "@webpack/common";
import gitHash from "~git-hash";

import { Logger } from "@utils/Logger";
import { copyToClipboard } from "@utils/clipboard";
import { relaunch } from "@utils/native";

const logger = new Logger("CrashRecovery");

/*
 * Recovery Mode: crash-loop protection, last-known-good plugin snapshots, plugin quarantine,
 * diagnostics, and the floating recovery panel that opens over Discord's crash screen
 * ("Well, this is awkward..."). Everything persists in the local DataStore only — recovery is
 * fully offline, and nothing is ever uploaded or shared automatically (see buildReport and the
 * built-in Privacy Controls).
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
            openRecoveryOverlay("Crash Loop Protection: this session keeps failing (also on last startup). Use One-Click Repair, then Safe Restart.");
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
        openRecoveryOverlay("Multiple plugins failed during startup. Quarantine them via One-Click Repair, then Safe Restart.");
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

/* ------------------------------------ overlay + panel ----------------------------------------- */

const OVERLAY_HOST_ID = "vc-crash-recovery-overlay";

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

const openButtonStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 99999,
    boxShadow: "0 8px 24px rgba(0,0,0,.5)"
};

function OverlayRoot() {
    const [open, setOpen] = React.useState(overlayOpen);

    React.useEffect(() => {
        const listener = () => setOpen(overlayOpen);
        overlayStateListeners.add(listener);
        return () => { overlayStateListeners.delete(listener); };
    }, []);

    return open
        ? <RecoveryPanel />
        : (
            <Button variant="dangerPrimary" onClick={() => openRecoveryOverlay("Recovery Mode opened manually.")} style={openButtonStyle}>
                🩺 Open Recovery Mode
            </Button>
        );
}

const panelStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 24,
    left: "50%",
    transform: "translateX(-50%)",
    width: 620,
    maxWidth: "94vw",
    maxHeight: "78vh",
    overflowY: "auto",
    background: "var(--background-base-lowest, #111214)",
    color: "var(--text-default, #dbdee1)",
    borderRadius: 10,
    boxShadow: "0 12px 40px rgba(0,0,0,.55)",
    padding: 14,
    zIndex: 99999,
    fontSize: 14
};

const RecoveryPanel = ErrorBoundary.wrap(function RecoveryPanel() {
    const [rev, setRev] = React.useState(0);
    const refresh = () => setRev(r => r + 1);

    const [plan, setPlan] = React.useState<string[]>([]);
    const [dep, setDep] = React.useState<DependencyCheckResult | null>(null);
    const [applied, setApplied] = React.useState<string[] | null>(null);
    const [restored, setRestored] = React.useState<boolean | null>(null);
    const [reportText, setReportText] = React.useState("");

    // reload diagnostics whenever something mutated (rev) or session state changed
    React.useEffect(() => {
        let cancelled = false;
        buildRepairPlan().then(p => { if (!cancelled) setPlan(p); });
        checkDependencies().then(d => { if (!cancelled) setDep(d); });
        return () => { cancelled = true; };
    }, [rev]);

    React.useEffect(() => {
        const listener = () => setRev(r => r + 1);
        uiUpdateListeners.add(listener);
        return () => { uiUpdateListeners.delete(listener); };
    }, []);

    // Latest Known Good differences tell the user whether a mod update may be related
    const lastGoodEntry = getLastKnownGood();
    const versionMismatch = lastGoodEntry != null && lastGoodEntry.gitHash !== gitHash;

    return (
        <div style={panelStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <BaseText size="lg" weight="semibold">Recovery Mode</BaseText>
                <Button variant="secondary" size="xs" onClick={closeOverlay}>Close</Button>
            </div>
            {overlayReason && <BaseText size="sm" color="text-muted">{overlayReason}</BaseText>}

            <StatusSection rev={rev} />

            <section style={{ marginTop: 10 }}>
                <BaseText size="sm" weight="semibold">One-Click Repair</BaseText>
                {plan.map((p, i) => <BaseText key={i} size="sm" color="text-muted">• {p}</BaseText>)}
                {applied != null && (
                    <BaseText size="sm" color="text-muted">
                        {applied.length ? `Quarantined after repair: ${applied.join(", ")}. Use Safe Restart for it to take full effect.` : "Nothing needed quarantining."}
                    </BaseText>
                )}
                {restored != null && (
                    <BaseText size="sm" color="text-muted">
                        {restored ? "Last Known Good configuration restored." : "No Last Known Good configuration saved yet."}
                    </BaseText>
                )}
            </section>

            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button variant="dangerPrimary" size="small" onClick={async () => {
                    setApplied(await applyRepairPlan());
                    refresh();
                }}>
                    One-Click Repair
                </Button>
                <Button variant="secondary" size="small" onClick={async () => {
                    setRestored(await restoreLastKnownGood());
                    refresh();
                }}>
                    Restore Last Known Good
                </Button>
                <Button variant="secondary" size="small" onClick={() => relaunch()}>
                    Safe Restart
                </Button>
            </div>

            {/* Last Known Good + Update Rollback */}
            <section style={{ marginTop: 10 }}>
                <BaseText size="sm" weight="semibold">Last Known Good</BaseText>
                {lastGoodEntry ? (
                    <BaseText size="sm" color="text-muted">
                        Saved {new Date(lastGoodEntry.time).toLocaleString()} on build {lastGoodEntry.gitHash.slice(0, 7)}.
                        {versionMismatch && " This snapshot comes from a different build — if the update itself is what crashes, restore it above and reinstall the previous Limey V1 build with your installer (Update Rollback)."}
                    </BaseText>
                ) : (
                    <BaseText size="sm" color="text-muted">No good session remembered yet.</BaseText>
                )}
            </section>

            {/* Dependency Checker */}
            <section style={{ marginTop: 10 }}>
                <BaseText size="sm" weight="semibold">Dependency Checker</BaseText>
                {dep == null ? null : dep.ok
                    ? <BaseText size="sm" color="text-muted">All enabled plugins resolved their dependencies and started.</BaseText>
                    : dep.entries.map((d, i) => <BaseText key={i} size="sm" color="text-muted">• {d}</BaseText>)}
            </section>

            {/* Plugin Quarantine management */}
            <QuarantineSection />

            {/* Recovery History */}
            <HistorySection rev={rev} />

            {/* Privacy Controls */}
            <section style={{ marginTop: 10, borderTop: "1px solid var(--background-base-lower, #1e1f22)", paddingTop: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <BaseText size="sm" weight="semibold">Privacy Controls</BaseText>
                    <Button
                        variant="link"
                        size="min"
                        onClick={async () => {
                            setReportText(JSON.stringify(await buildReport(), null, 2));
                        }}
                    >
                        Inspect diagnostic report
                    </Button>
                </div>
                <BaseText size="xs" color="text-muted">
                    Diagnostics stay on your device. Nothing is shared automatically — copy the report only if you choose to.
                </BaseText>
                {reportText && (
                    <>
                        <textarea
                            readOnly
                            value={reportText}
                            style={{
                                width: "100%", minHeight: 90, marginTop: 4, fontSize: 11, fontFamily: "monospace",
                                whiteSpace: "pre", background: "var(--background-base-lower, #1e1f22)",
                                color: "inherit", border: "none", borderRadius: 4, padding: 6
                            }}
                            onFocus={e => e.currentTarget.select()}
                        />
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                            <Button variant="secondary" size="xs" onClick={() => void copyToClipboard(reportText)}>Copy</Button>
                            <Button variant="secondary" size="xs" onClick={() => setReportText("")}>Hide</Button>
                        </div>
                    </>
                )}
            </section>
        </div>
    );
}, { noop: true });

function StatusSection({ rev }: { rev: number; }) {
    void rev;
    const failures = [...new Set(sessionFailures.map(f => f.plugin))];
    return (
        <section style={{ marginTop: 6 }}>
            <BaseText size="sm" weight="semibold">Current session</BaseText>
            <BaseText size="sm" color="text-muted">
                {crashesCount === 0
                    ? "No crashes recorded this session."
                    : `${crashesCount} crash(es) this session${lastCrashMessage ? ` — last: ${lastCrashMessage}` : ""}.`}
                {" "}
                {failures.length ? `Startup failures: ${failures.join(", ")}.` : "All enabled plugins started."}
                {Object.keys(quarantine).length ? ` Quarantined: ${Object.keys(quarantine).join(", ")}.` : ""}
            </BaseText>
        </section>
    );
}

function QuarantineSection() {
    const [q, setQ] = React.useState<Record<string, QuarantineEntry>>(() => getQuarantine());

    React.useEffect(() => {
        const listener = () => setQ(getQuarantine());
        uiUpdateListeners.add(listener);
        return () => { uiUpdateListeners.delete(listener); };
    }, []);

    const names = Object.keys(q);

    return (
        <section style={{ marginTop: 10 }}>
            <BaseText size="sm" weight="semibold">Plugin Quarantine</BaseText>
            <BaseText size="sm" color="text-muted">Quarantined plugins stay disabled until you restore them.</BaseText>
            {names.length === 0
                ? <BaseText size="sm" color="text-muted">Nothing is currently quarantined.</BaseText>
                : names.map(n => (
                    <div key={n} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                        <BaseText size="sm">{n}</BaseText>
                        <BaseText size="xs" color="text-muted">{q[n].reason}</BaseText>
                        <Button variant="link" size="min" onClick={() => { unquarantinePlugin(n); setQ(getQuarantine()); }}>
                            Restore
                        </Button>
                    </div>
                ))}
        </section>
    );
}

function HistorySection({ rev }: { rev: number; }) {
    void rev;
    const events = getHistory().slice(-12).reverse();
    return (
        <section style={{ marginTop: 10 }}>
            <BaseText size="sm" weight="semibold">Recovery History</BaseText>
            <div style={{ maxHeight: 150, overflowY: "auto", marginTop: 4 }}>
                {events.length === 0
                    ? <BaseText size="sm" color="text-muted">No events yet.</BaseText>
                    : events.map(h => (
                        <BaseText key={h.id} size="sm" color="text-muted">
                            [{new Date(h.time).toLocaleString()}] {h.type}: {h.detail}
                        </BaseText>
                    ))}
            </div>
        </section>
    );
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

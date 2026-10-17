/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { Constants, FluxDispatcher, React, RelationshipStore, RestAPI, showToast, UserStore } from "@webpack/common";

import { scamMatch } from "./patterns";
import {
    completeWebauthnMfa,
    isSecurityKeySetUp,
    isWebAuthnSupported,
    MFA_REQUIRED,
    removeSecurityKey,
    setUpSecurityKey
} from "./security";

const logger = new Logger("AntiScam");

const PURGE_LOG_STORE = "AntiScamV1:purgeLog";
const PURGE_LOG_CAP = 200;
/** Discord's message-delete rate limit is roughly 5 deletes / 5s per channel. */
const DELETE_DELAY_MS = 300;

export interface PurgeLogEntry {
    channelId: string;
    messageId: string;
    /** Sender whose message got flagged */
    userId: string;
    username?: string;
    rules: string[];
    at: number;
    deleted?: boolean;
}

let purgeLog: PurgeLogEntry[] = [];
let purgeLogDirty = false;

function persistPurgeLog(): void {
    if (purgeLogDirty) return; // one write at a time keeps the DataStore quiet
    purgeLogDirty = true;
    setTimeout(() => {
        purgeLogDirty = false;
        void DataStore.set(PURGE_LOG_STORE, purgeLog).catch(e => logger.warn("failed to persist scam log", e));
    }, 1000);
}

async function loadPurgeLog(): Promise<void> {
    try {
        const stored = await DataStore.get<PurgeLogEntry[]>(PURGE_LOG_STORE);
        if (Array.isArray(stored)) purgeLog = stored.filter(e => e?.messageId);
    } catch (e) {
        logger.warn("failed to load scam log", e);
    }
}

async function rememberScam(message: any, rules: string[]): Promise<void> {
    const entry: PurgeLogEntry = {
        channelId: message.channel_id ?? message.channelId,
        messageId: message.id,
        userId: message.author.id,
        username: message.author.username,
        rules,
        at: Date.now(),
    };
    purgeLog = [entry, ...purgeLog.filter(e => e.messageId !== entry.messageId)].slice(0, PURGE_LOG_CAP);
    persistPurgeLog();
}

/* ------------------------------------------------------------------------- */
/* Relationship helpers (ignore = the milder block Discord ships)            */
/* ------------------------------------------------------------------------- */

interface RelationshipActionsModule {
    addIgnored?: (userId: string) => unknown;
    addBlocked?: (userId: string) => unknown;
    deleteIgnored?: (userId: string) => unknown;
    deleteBlocked?: (userId: string) => unknown;
}

const RelationshipActions = () => {
    try {
        return findByProps("addIgnored", "deleteIgnored") as RelationshipActionsModule | null
            ?? findByProps("addBlocked", "deleteBlocked") as RelationshipActionsModule | null;
    } catch {
        return null;
    }
};

/** Ignore (block) a scam sender so their messages fade out immediately. */
async function ignoreUser(userId: string): Promise<boolean> {
    if (RelationshipStore.isIgnored?.(userId) || RelationshipStore.isBlocked?.(userId)) return false;
    const mod = RelationshipActions();
    try {
        if (typeof mod?.addIgnored === "function") {
            await mod.addIgnored(userId);
            return true;
        }
        if (typeof mod?.addBlocked === "function") {
            await mod.addBlocked(userId);
            return true;
        }
        // Newer builds dropped the legacy pair; fall through to the REST call.
        await RestAPI.put({ url: `/users/@me/relationships/${userId}`, body: { type: 2 } });
        return true;
    } catch (e) {
        logger.warn("failed to ignore scam sender", userId, e);
        return false;
    }
}

/** Undo an ignore (or block, or friendship removal equivalent) for a user id. */
async function unignoreUser(userId: string): Promise<boolean> {
    const wasIgnored = !!RelationshipStore.isIgnored?.(userId);
    const wasBlocked = !!RelationshipStore.isBlocked?.(userId);
    if (!wasIgnored && !wasBlocked) return false;

    const mod = RelationshipActions();
    try {
        // Prefer the exact inverse of the current state; either inverse makes
        // the user no longer ignored/blocked, so a fallback is fine.
        const target = (wasIgnored ? mod?.deleteIgnored : mod?.deleteBlocked)
            ?? mod?.deleteIgnored
            ?? mod?.deleteBlocked;
        if (typeof target === "function") {
            await target(userId);
            return true;
        }
        // Fall back to the explicit REST path when the client module is unavailable.
        await modRestDeleteRelationship(userId);
        return true;
    } catch (e) {
        logger.warn("failed to unignore user", userId, e);
        return false;
    }
}

async function modRestDeleteRelationship(userId: string): Promise<void> {
    await RestAPI.del({ url: `/users/@me/relationships/${userId}` });
}

/* ------------------------------------------------------------------------- */
/* V1 actions                                                                */
/* ------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Unignores every user whose scam V1 recorded, then deletes each recorded
 * message. Returns a summary toast.
 */
async function purgeScamMessages(): Promise<void> {
    const entries = purgeLog.filter(e => !e.deleted);
    if (entries.length === 0) {
        showToast("Anti-Scam: no recorded scam messages to delete.", "message");
        return;
    }

    const userIds = [...new Set(entries.map(e => e.userId).filter(Boolean))];
    showToast(`Anti-Scam: unignoring ${userIds.length} user(s) before deleting ${entries.length} message(s)…`, "message");

    let unignored = 0;
    for (const userId of userIds) {
        if (await unignoreUser(userId)) unignored++;
    }

    let deleted = 0;
    let failed = 0;
    for (const entry of entries) {
        try {
            await RestAPI.del({ url: `/channels/${entry.channelId}/messages/${entry.messageId}` });
            entry.deleted = true;
            deleted++;
        } catch (e: any) {
            const code = e?.body?.code ?? e?.code;
            // 20018/50003: message already gone or channel not found — treat as
            // harmless; drops the entry from the log to keep it clean.
            if (code === 20018 || code === 50003 || code === 10008) {
                entry.deleted = true;
            } else {
                failed++;
                logger.warn("failed to delete scam message", entry.messageId, e);
                if (code === 429) {
                    await sleep(1000); // wait off the tiny rate-limit window
                    try {
                        await RestAPI.del({ url: `/channels/${entry.channelId}/messages/${entry.messageId}` });
                        entry.deleted = true;
                        deleted++;
                        failed--;
                    } catch { /* leave failed */ }
                }
            }
        }
        await sleep(DELETE_DELAY_MS);
    }

    purgeLog = purgeLog.filter(e => !e.deleted);
    void DataStore.set(PURGE_LOG_STORE, purgeLog).catch(() => null);

    showToast(
        `Anti-Scam purge: ${deleted} message(s) deleted, ${unignored} user(s) unignored${failed ? `, ${failed} could not be deleted` : ""}.`,
        failed ? "failure" : "success",
    );
}

/**
 * Log out every other session. Runs Discord's real MFA flow: when Discord
 * rejects the protected request with code 60003 the user verifies with their
 * *Discord-registrered* security key, and the requests are retried with the
 * resulting X-Discord-MFA-Authorization token. The session on the machine V1
 * runs from is always kept.
 */
async function logOutAllOtherDevices(): Promise<void> {
    if (!(await isSecurityKeySetUp())) {
        throw new Error(
            "Your Discord account has no security key enrolled — set one up with 'Setup security key with Discord' in Anti-Scam settings first "
            + "(logging out all devices requires two-factor).",
        );
    }

    const data = await RestAPI.get({ url: Constants.Endpoints.AUTH_SESSIONS }) as any;
    const sessions: any[] = data?.body?.user_sessions ?? [];
    const others = sessions.filter(s => s && !s.current && typeof s.id_hash === "string");
    if (others.length === 0) {
        showToast("Anti-Scam: no other devices are logged in.", "message");
        return;
    }

    showToast(`Anti-Scam: logging out ${others.length} other device(s)…`, "message");
    let done = 0;
    let failed = 0;
    let mfaToken: string | null = null;
    for (const session of others) {
        try {
            // id_hash contains `/` and `=`; it must be percent-encoded, or the
            // router only ever sees the segment up to the first `/` and 404s.
            const headers = mfaToken ? { "X-Discord-MFA-Authorization": mfaToken } : undefined;
            await RestAPI.post({
                url: `/users/@me/sessions/${encodeURIComponent(session.id_hash)}/logout`,
                body: {},
                headers,
            } as any);
            done++;
        } catch (e: any) {
            if (e?.body?.code === MFA_REQUIRED && !mfaToken) {
                // Discord demands 2FA: complete the webauthn challenge with
                // the user's own Discord security key, then retry everything.
                mfaToken = await completeWebauthnMfa(e);
                try {
                    await RestAPI.post({
                        url: `/users/@me/sessions/${encodeURIComponent(session.id_hash)}/logout`,
                        body: {},
                        headers: { "X-Discord-MFA-Authorization": mfaToken },
                    } as any);
                    done++;
                } catch (retryError) {
                    failed++;
                    logger.warn("failed to log out session even with MFA token", session.id_hash, retryError);
                }
            } else {
                failed++;
                logger.warn("failed to log out session", session.id_hash, e);
            }
        }
        await sleep(150);
    }

    showToast(
        failed
            ? `Anti-Scam: logged out ${done} device(s); ${failed} failed (see console for details).`
            : `Anti-Scam: logged out all ${done} other device(s). This device is untouched.`,
        failed ? "failure" : "success",
    );
}

/* ------------------------------------------------------------------------- */
/* Detection hooks                                                           */
/* ------------------------------------------------------------------------- */

function isSystemMessage(message: any): boolean {
    // System messages (joins, pins, calls, auto-mod notices, …) and author
    // system states can't be scam bait.
    if (typeof message?.type === "number" && message.type !== 0) return true;
    if (message?.author?.system) return true;
    return false;
}

function detect(message: any): string[] | null {
    const content = message?.content;
    if (typeof content !== "string" || !content) return null;

    const { scam, rules } = scamMatch(content);
    if (!scam) return null;
    return rules;
}

const onMessageCreate = (e: any) => {
    const message = e?.message ?? e;
    if (!message || isSystemMessage(message)) return;

    const rules = detect(message);
    if (!rules) return;

    const me = UserStore.getCurrentUser()?.id;
    const who = message.author?.username ?? message.author?.id ?? "someone";

    console.warn(
        `[AntiScam] flagged message from ${who} (${rules.join(", ")}) — channel ${message.channel_id ?? "unknown"}`,
    );

    if (settings.store.toastOnDetect) {
        showToast(`AntiScam: ${who} — ${rules.join(", ")}`, "failure");
    }

    if (message.author?.id && message.author.id !== me) {
        if (settings.store.recordScamLog) {
            void rememberScam(message, rules);
        }
        // Ignore (block) the scam sender right away when requested. Deletion
        // un-ignores them first.
        if (settings.store.autoIgnore) {
            void ignoreUser(message.author.id);
        }
        if (settings.store.deleteOnDetect) {
            void RestAPI.del({ url: `/channels/${message.channel_id}/messages/${message.id}` }).catch(
                err => logger.warn("failed to auto-delete scam message", err),
            );
        }
    }
};

/* ------------------------------------------------------------------------- */
/* Inline decoration + settings UI                                           */
/* ------------------------------------------------------------------------- */

function ScamBadge({ message }: { message?: any; }) {
    if (!settings.store.inlineBadge) return null;

    const rules = detect(message);
    if (!rules) return null;

    return (
        <span
            title={`AntiScam: ${rules.join(", ")}`}
            style={{
                fontSize: "11px",
                marginLeft: "3px",
                cursor: "default",
                userSelect: "none",
                verticalAlign: "middle",
                display: "inline-flex",
                alignItems: "center",
                color: "#ed4245",
                fontWeight: 700,
            }}
        >
            🚫 Scam
        </span>
    );
}

function PurgeButton() {
    const [busy, setBusy] = React.useState(false);
    return (
        <button
            disabled={busy}
            onClick={() => {
                if (busy) return;
                setBusy(true);
                purgeScamMessages().catch(e => {
                    logger.warn("purge failed", e);
                    showToast(`Anti-Scam purge failed: ${e instanceof Error ? e.message : String(e)}`, "failure");
                }).finally(() => setBusy(false));
            }}
            style={{
                padding: "4px 10px",
                borderRadius: 4,
                background: "#ed4245",
                color: "#fff",
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
            }}
        >
            {busy ? "Deleting…" : "Delete all recorded scam messages"}
        </button>
    );
}

function SecurityKeyButton() {
    const [busy, setBusy] = React.useState(false);
    const [hasKey, setHasKey] = React.useState<boolean>(false);
    React.useEffect(() => { void isSecurityKeySetUp().then(v => setHasKey(v)); }, []);

    return (
        <button
            disabled={!isWebAuthnSupported() || busy}
            onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                    if (await isSecurityKeySetUp()) {
                        await removeSecurityKey();
                        showToast("Anti-Scam: V1 passkey removed.", "success");
                    } else {
                        const me = UserStore.getCurrentUser();
                        if (!me) throw new Error("log in first so V1 can add the security key to this account.");
                        await setUpSecurityKey();
                        showToast("Anti-Scam: security key enrolled with Discord — 2FA-class actions are now available.", "success");
                    }
                } catch (e: unknown) {
                    logger.warn("V1 passkey setup failed", e);
                    showToast(`Anti-Scam security key: ${e instanceof Error ? e.message : String(e)}`, "failure");
                } finally {
                    setHasKey(await isSecurityKeySetUp());
                    setBusy(false);
                }
            }}
            style={{
                padding: "4px 10px",
                borderRadius: 4,
                background: "#5865f2",
                color: "#fff",
                fontWeight: 600,
                cursor: isWebAuthnSupported() ? (busy ? "wait" : "pointer") : "not-allowed",
            }}
        >
            {busy ? "Waiting for your authenticator…" : (hasKey ? "Remove V1 passkey" : "Set up security key with Discord")}
        </button>
    );
}

function LogoutDevicesButton() {
    const [busy, setBusy] = React.useState(false);
    return (
        <button
            disabled={busy}
            onClick={() => {
                if (busy) return;
                setBusy(true);
                logOutAllOtherDevices().catch(e => {
                    logger.warn("logout of all other devices failed", e);
                    showToast(`Anti-Scam device logout failed: ${e instanceof Error ? e.message : String(e)}`, "failure");
                }).finally(() => setBusy(false));
            }}
            style={{
                padding: "4px 10px",
                borderRadius: 4,
                background: "#ed4245",
                color: "#fff",
                fontWeight: 600,
                cursor: busy ? "wait" : "pointer",
            }}
        >
            {busy ? "Logging out…" : "Log out all other devices (2FA required)"}
        </button>
    );
}

const settings = definePluginSettings({
    toastOnDetect: {
        type: OptionType.BOOLEAN,
        description: "Send a toast when a message you can see matches a scam rule.",
        default: true,
        restartNeeded: false,
    },
    inlineBadge: {
        type: OptionType.BOOLEAN,
        description: "Decorate matching messages with a 🚫 Scam badge (tooltip lists the rules caught).",
        default: true,
        restartNeeded: false,
    },
    recordScamLog: {
        type: OptionType.BOOLEAN,
        description: "Record detected scam messages so the purge action can delete them (keeps the latest 200).",
        default: true,
        restartNeeded: false,
    },
    autoIgnore: {
        type: OptionType.BOOLEAN,
        description: "Automatically ignore users whose messages match scam patterns. The purge action unignores them first.",
        default: true,
        restartNeeded: false,
    },
    deleteOnDetect: {
        type: OptionType.BOOLEAN,
        description: "Auto-delete scams the moment they arrive (restores safety, messages land in the purge log).",
        default: false,
        restartNeeded: false,
    },
    purgeAction: {
        type: OptionType.COMPONENT,
        description: "Unignores every user that V1 caught receiving scam, then deletes every recorded scam message.",
        component: () => <PurgeButton />,
    },
    securityKeyAction: {
        type: OptionType.COMPONENT,
        description: "Link a V1 security key (passkey) to this Discord account. Required before V1 performs 2FA-class actions like logging out all devices.",
        component: () => <SecurityKeyButton />,
    },
    logoutAction: {
        type: OptionType.COMPONENT,
        description: "Log out every other session Discord knows about — the device V1 is running from always stays signed in.",
        component: () => <LogoutDevicesButton />,
    },
});

export default definePlugin({
    name: "AntiScam",
    description: "Flags the known scam-bot patterns from AutoMod (cam bait, sexual invite links, fake steam gift markdown, mimic domains, attachment-image walls) in messages you can see — 🚫 Scam decoration plus an optional toast. Plain steamcommunity.com links are allowed. Optionally records the scams in a log so one click can unignore their senders and delete every recorded scam message, and can log out all other devices once you've linked a V1 passkey (2FA-class action).",
    tags: ["Utility", "Media"],
    searchTerms: ["anti scam", "scam", "detect", "automod", "steam gift", "phishing", "nsfw invite", "passkey", "sessions"],
    authors: [Devs.Limey],

    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own message events to check new messages against the scam patterns.",
            risk: "A buggy or abused plugin could act on the content of private conversation. This plugin only flags locally and never sends anything anywhere."
        },
        {
            id: "deleteScamMessages",
            title: "Delete recorded scam messages and ignore/unignore senders",
            description: "Lets the purge action remove scam messages you can delete and change the ignore state of their senders.",
            risk: "Deleting messages and toggling ignores are irreversible; older messages you didn't catch may be permanently lost."
        },
        {
            id: "logOutOtherDevices",
            title: "Log out every other Discord device",
            description: "Runs the Discord endpoint that signs out every session except the one V1 runs on, after the passkey check.",
            risk: "Signs out all other devices of your Discord account in one go; make sure you understand that first."
        },
        {
            id: "webauthnSecurityKey",
            title: "Register a V1 WebAuthn (passkey) security key",
            description: "Creates a local passkey tied to discord.com (or your current origin) to authorize 2FA-class actions.",
            risk: "The credential lives in your platform authenticator, not on the Limey V1 server."
        }
    ],

    settings,
    dependencies: ["MessageDecorationsAPI"],

    toolboxActions: {
        "Delete recorded scams": () => void purgeScamMessages().catch(e => logger.warn("toolbox purge failed", e)),
        "Log out other devices": () => void logOutAllOtherDevices().catch(e => logger.warn("toolbox logout failed", e)),
    },

    start() {
        void loadPurgeLog();
        addMessageDecoration("AntiScam", props => <ScamBadge message={props?.message} />);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    stop() {
        removeMessageDecoration("AntiScam");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    },
});

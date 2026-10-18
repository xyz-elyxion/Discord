/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import type { Channel } from "@limeyV1/discord-types";
import { ChannelType } from "@limeyV1/discord-types/enums";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import { ChannelStore, Constants, FluxDispatcher, React, RelationshipStore, RestAPI, showToast, UserStore } from "@webpack/common";

import { scamMatch } from "./patterns";
import {
    completeWebauthnMfa,
    getSecurityKeyState,
    isSecurityKeySetUp,
    isWebAuthnSupported,
    MFA_REQUIRED,
    removeSecurityKey,
    type SecurityKeyState,
    setUpSecurityKey } from "./security";

const logger = new Logger("AntiScam");

const PURGE_LOG_STORE = "AntiScamV1:purgeLog";
const PURGE_LOG_CAP = 200;

export interface PurgeLogEntry {
    channelId: string;
    messageId: string;
    /** Sender whose message got flagged — the recording client's own user
     *  id marks an entry as a self-scam (from the hijacked-account case). */
    userId: string;
    username?: string;
    rules: string[];
    at: number;
    /** Set for entries whose message V1 deleted (own messages only). */
    removed?: boolean;
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

async function rememberScam(message: any, rules: string[], isSelf = false): Promise<void> {
    const entry: PurgeLogEntry = {
        channelId: message.channel_id ?? message.channelId,
        messageId: message.id,
        userId: message.author.id,
        username: message.author.username,
        rules,
        at: Date.now(),
        ...(isSelf ? { removed: false } : {}),
    } as PurgeLogEntry;
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
 * Unignores every user whose scam V1 recorded, deletes every recorded scam
 * message that was sent from THIS account (self-scam entries only), and
 * clears the log. Other people's messages are NEVER deleted — incoming scams
 * are flagged only.
 */
async function purgeScamMessages(): Promise<void> {
    const me = UserStore.getCurrentUser()?.id;
    const entries = purgeLog;
    if (entries.length === 0) {
        showToast("Anti-Scam: no recorded scam messages in the log.", "message");
        return;
    }

    const userIds = [...new Set(entries.map(e => e.userId).filter(Boolean))];
    showToast(`Anti-Scam: unignoring ${userIds.length} user(s) from ${entries.length} recorded scam(s)…`, "message");

    let unignored = 0;
    for (const userId of userIds) {
        if (await unignoreUser(userId)) unignored++;
    }

    // Only entries whose sender is this account are deletable — the
    // hijacked-session messages V1 recorded. Author-of-record check keeps the
    // guarantee: no other user's message is ever touched.
    const mine = me ? entries.filter(e => e.userId === me && !e.removed) : [];
    let deleted = 0;
    let failed = 0;
    for (const entry of mine) {
        try {
            await RestAPI.del({ url: `/channels/${entry.channelId}/messages/${entry.messageId}` });
            entry.removed = true;
            deleted++;
        } catch (e: any) {
            const code = e?.body?.code ?? e?.code;
            // 10008/20018/50003: already gone or channel not found — harmless.
            if (code === 10008 || code === 20018 || code === 50003) {
                entry.removed = true;
            } else {
                failed++;
                logger.warn("failed to delete own scam message", entry.messageId, e);
            }
        }
        await sleep(300); // Discord's message-delete rate limit is ~5/5s per channel
    }

    // Cleared entries whose own-message counterpart was deleted (or that were
    // never own messages); failed own deletes stay so the next purge retries.
    purgeLog = purgeLog.filter(e => e.removed === false);
    void DataStore.set(PURGE_LOG_STORE, purgeLog).catch(() => null);

    showToast(
        failed
            ? `Anti-Scam purge: ${unignored} user(s) unignored, ${deleted} of your message(s) deleted, ${failed} of yours could not be deleted (log keeps retrying). Other people's messages are never touched.`
            : `Anti-Scam purge: ${unignored} user(s) unignored, ${deleted} of your scam message(s) deleted, log of ${entries.length} scam(s) cleared. Other people's messages are left untouched (flagged only).`,
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
    const hashes = others.map(s => s.id_hash as string);
    let done = 0;
    let failed = 0;
    let mfaToken: string | null = null;

    // Discord's own settings flow uses the bulk endpoint — one call per batch
    // (up to 64 hashes) instead of one request per session. The old
    // per-session /users/@me/sessions/{id}/logout route is kept as a fallback
    // for batches Discord rejects.
    const logoutBulk = (sessionIds: string[], headers?: Record<string, string>) => RestAPI.post({
        url: Constants.Endpoints.AUTH_SESSIONS_LOGOUT ?? "/auth/sessions/logout",
        body: { session_id_hashes: sessionIds },
        headers,
    } as any) as any;
    const logoutSingle = (idHash: string, headers?: Record<string, string>) => RestAPI.post({
        url: `/users/@me/sessions/${encodeURIComponent(idHash)}/logout`,
        body: {},
        headers,
    } as any) as any;

    for (let start = 0; start < hashes.length; start += 64) {
        const batch = hashes.slice(start, start + 64);
        try {
            await logoutBulk(batch, mfaToken ? { "X-Discord-MFA-Authorization": mfaToken } : undefined);
            done += batch.length;
        } catch (bulkError: any) {
            if (bulkError?.body?.code === MFA_REQUIRED && !mfaToken) {
                // Discord demands 2FA: complete the webauthn challenge with
                // the user's own Discord security key, then retry everything.
                try {
                    mfaToken = await completeWebauthnMfa(bulkError);
                    await logoutBulk(batch, { "X-Discord-MFA-Authorization": mfaToken });
                    done += batch.length;
                } catch (retryError) {
                    failed += batch.length;
                    logger.warn("bulk logout failed even with MFA token", retryError);
                }
                continue;
            }
            // Bulk refused for another reason? Fall back to one request per
            // session so a single bad hash can't sink the whole batch.
            for (const hash of batch) {
                try {
                    await logoutSingle(hash, mfaToken ? { "X-Discord-MFA-Authorization": mfaToken } : undefined);
                    done++;
                } catch (e: any) {
                    failed++;
                    logger.warn("failed to log out session", hash, e);
                }
                await sleep(150);
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
        // Ignore (block) the scam sender right away when requested. V1 never
        // deletes other people's messages — incoming scams are flagged only.
        if (settings.store.autoIgnore) {
            void ignoreUser(message.author.id);
        }
        return;
    }

    // A matching message from THIS account: the classic hijacked-bot case —
    // someone/something sent the MrBeast-style scam AS you, e.g. to a friend
    // you've previously ignored. Damage control: unignore the recipients and
    // wave a loud flag about the compromise.
    if (me) {
        // Record it so the purge action can delete this own message later.
        if (settings.store.recordScamLog) {
            void rememberScam(message, rules, true);
        }
        void repairSelfScam(message, rules);
    }
};

/**
 * Compensation for a hijacked session sending scam AS this account: unignore
 * every recipient of the DM/group-DM it landed in, so the friends the scam
 * was fired at can see your real messages again. With Delete On Detect on,
 * the message is also deleted — deleting your OWN message via DELETE
 * /channels/{id}/messages/{message.id} always works, no permissions needed.
 */
async function repairSelfScam(message: any, rules: string[]): Promise<void> {
    const channelId = message.channel_id ?? message.channelId;
    const channel: Channel | undefined = ChannelStore.getChannel?.(channelId) as Channel | undefined;
    if (!channel) return;

    const type = channel.type as number;
    // Guild channels are deliberately excluded: a scam-pattern match on a
    // guild message must not silently unignore members over a false positive.
    if (type !== ChannelType.DM && type !== ChannelType.GROUP_DM) return;

    const recipients = (channel.recipients ?? []).filter(id => id && id !== message.author.id);
    if (recipients.length === 0) return;

    let unignored = 0;
    for (const id of recipients) {
        if (await unignoreUser(id)) unignored++;
    }

    let deletedNote = "";
    let entryWasRemoved = false;
    if (settings.store.deleteOnDetect) {
        try {
            await RestAPI.del({ url: `/channels/${channelId}/messages/${message.id}` });
            deletedNote = " The scam message itself was deleted (your own message).";
            entryWasRemoved = true;
        } catch (e) {
            logger.warn("failed to auto-delete own scam message", e);
            deletedNote = " The scam message could not be deleted — remove it manually.";
        }
    }
    // Keep the purge log in sync: when the instant delete already went
    // through, its entry must not make the purge delete a non-message.
    if (entryWasRemoved) markSelfScamRemoved(message.id);

    showToast(
        `AntiScam: a message was sent FROM YOUR ACCOUNT matching scam rules (${rules.join(", ")}) — your account may be compromised. `
        + `Unignored ${unignored} recipient(s) of ${type === ChannelType.GROUP_DM ? "that group DM" : "that DM"}.${deletedNote} `
        + "Log out all other devices and change your password.",
        "failure",
    );
}

/** Flag the purge-log entry for a successfully deleted (or otherwise gone)
 *  own message so the purge action won't retry a dead delete. */
function markSelfScamRemoved(messageId: string): void {
    const entry = purgeLog.find(e => e.messageId === messageId);
    if (entry) {
        entry.removed = true;
        persistPurgeLog();
    }
}

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
            {busy ? "Cleaning up…" : "Unignore senders + delete my scam messages"}
        </button>
    );
}

type KeyAction = "add" | "remove" | "add-another";

const KEY_ACTION_LABELS: Record<KeyAction, string> = {
    add: "Set up security key with Discord",
    remove: "Remove V1-enrolled security key",
    // Discord permits multiple security keys, so a key enrolled outside V1
    // never blocks enrolling one that V1 can identify and later remove.
    "add-another": "Enrol another key (existing one wasn't made by V1)",
};

function actionForState(state: SecurityKeyState | null): KeyAction {
    if (!state) return "add";
    if (!state.anyKey) return "add";
    if (state.v1Enrolled === true) return "remove";
    // Key(s) exist but V1 can't prove it created one: removal would dead-end,
    // so offer adding another key instead (which V1 then owns).
    return "add-another";
}

function SecurityKeyButton() {
    const [busy, setBusy] = React.useState(false);
    const [state, setState] = React.useState<SecurityKeyState | null>(null);
    React.useEffect(() => { void getSecurityKeyState().then(setState); }, []);

    const action = actionForState(state);

    return (
        <button
            disabled={!isWebAuthnSupported() || busy}
            onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                    if (action === "remove") {
                        await removeSecurityKey();
                        showToast("Anti-Scam: the V1-enrolled security key was removed from your Discord account.", "success");
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
                    setState(await getSecurityKeyState());
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
            {busy ? "Waiting for your authenticator…" : KEY_ACTION_LABELS[action]}
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
        description: "Record detected scam messages so the purge action can delete yours and unignore their senders (keeps the latest 200). Your own matching messages are recorded too.",
        default: true,
        restartNeeded: false,
    },
    autoIgnore: {
        type: OptionType.BOOLEAN,
        description: "Automatically ignore users whose messages match scam patterns. The purge action unignores them again.",
        default: true,
        restartNeeded: false,
    },
    deleteOnDetect: {
        type: OptionType.BOOLEAN,
        description: "Auto-delete YOUR OWN messages that match scam patterns (DM/group DM only) the moment V1 spots them — the hijacked-account case. Other people's scams are flagged, never deleted.",
        default: false,
        restartNeeded: false,
    },
    purgeAction: {
        type: OptionType.COMPONENT,
        description: "Unignores every user V1 recorded a scam for, then deletes every recorded scam message that was sent from YOUR account and clears the log. Never deletes other people's messages — those are flagged only.",
        component: () => <PurgeButton />,
    },
    securityKeyAction: {
        type: OptionType.COMPONENT,
        description: "Link a V1 security key (passkey) to this Discord account, or remove the one V1 enrolled. Required before V1 performs 2FA-class actions like logging out all devices.",
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
    description: "Flags the known scam-bot patterns from AutoMod (cam bait, sexual invite links, fake steam gift markdown, mimic domains, attachment-image walls) in messages you can see — 🚫 Scam decoration plus an optional toast. Other people's scam messages are flagged only, never deleted; a matching message sent FROM YOUR OWN account unignores the DM/group-DM recipients (and with Delete On Detect deletes just that message of yours). Optionally records the scams in a log so one click can unignore their senders, and can log out all other devices once you've linked a V1 passkey (2FA-class action).",
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
            title: "Delete your own flagged scam messages and ignore/unignore senders",
            description: "Lets Delete On Detect remove YOUR OWN messages that match scam patterns in DMs/group DMs, and lets the purge toggle the ignore state of senders V1 flagged.",
            risk: "Deleting your own message is irreversible; ignore-state changes alter who you've ignored or blocked."
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

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Converted from the BetterDiscord plugin "PasscodeLock" by arg0NNY
// (https://github.com/okdevme/DiscordPlugins) — re-implemented natively for Limey V1.

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { enableStyle, isStyleEnabled } from "@api/Styles";
import { ChannelType } from "@limeyV1/discord-types/enums";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, ChannelStore, createRoot, GuildStore, Menu, React, SelectedChannelStore, showToast, Toasts, useEffect, useRef, UserStore, useState } from "@webpack/common";

import managedStyle from "./styles.css?managed";

type CodeType = "4-digit" | "6-digit" | "custom-numeric";

interface CodeHash {
    hash: string;
    salt: string;
    iterations: number;
}

const logger = new Logger("PasscodeLock");

// --- PBKDF2 hashing (same scheme as the original) ---------------------------

const b64binb = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const str2binb = (str: string) => new TextEncoder().encode(str);
const buf2hex = (buffer: ArrayBuffer) =>
    Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, "0")).join("");

async function pbkdf2(string: string, saltHex: string, iterations: number) {
    const key = await crypto.subtle.importKey("raw", str2binb(string), { name: "PBKDF2" }, false, ["deriveKey"]);
    const derived = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: hex2binb(saltHex),
            iterations,
            hash: { name: "SHA-1" }
        },
        key,
        { name: "HMAC", hash: "SHA-1", length: 160 },
        true,
        ["sign"]
    );
    const raw = await crypto.subtle.exportKey("raw", derived);
    return buf2hex(raw);
}

function hex2binb(hex: string) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

async function hashCode(code: string): Promise<CodeHash> {
    const salt = buf2hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const iterations = 4000;
    return { hash: await pbkdf2(code, salt, iterations), salt, iterations };
}

async function hashCheck(code: string, stored: CodeHash) {
    return (await pbkdf2(code, stored.salt, stored.iterations)) === stored.hash;
}

// --- Settings ----------------------------------------------------------------

const codeLength = () => {
    switch (settings.store.codeType as CodeType) {
        case "4-digit": return 4;
        case "6-digit": return 6;
        default: return -1;
    }
};

const settings = definePluginSettings({
    codeType: {
        description: "Code type",
        type: OptionType.SELECT,
        options: [
            { label: "4-Digit Numeric Code", value: "4-digit", default: true },
            { label: "6-Digit Numeric Code", value: "6-digit" },
            { label: "Custom Numeric Code", value: "custom-numeric" },
        ],
        onChange() {
            // Changing the code type invalidates the stored passcode
            settings.store.hash = "";
            showToast("Your passcode has been reset. Set it up again.", Toasts.Type.FAILURE);
        }
    },
    lockKeybind: {
        description: "Key combination that locks Discord (e.g. control+l)",
        type: OptionType.STRING,
        default: "control+l"
    },
    autolock: {
        description: "Auto-lock after inactivity (seconds, 0 = disabled)",
        type: OptionType.NUMBER,
        default: 0
    },
    lockOnStartup: {
        description: "Always lock on startup",
        type: OptionType.BOOLEAN,
        default: false
    },
    hideNotifications: {
        description: "Censor notifications while locked",
        type: OptionType.BOOLEAN,
        default: false
    },
    lockedList: {
        type: OptionType.COMPONENT,
        description: "Chats and servers that currently ask for your passcode. Unlock one here if you can no longer right-click it.",
        component: () => <LockedScopesList />
    },
    // Internal — not shown to the user. The passcode is stored as a
    // PBKDF2 hash with a random salt so the code itself is never saved.
    hash: { type: OptionType.STRING, default: "", hidden: true },
    salt: { type: OptionType.STRING, default: "", hidden: true },
    iterations: { type: OptionType.NUMBER, default: 4000, hidden: true },
    locked: { type: OptionType.BOOLEAN, default: false, hidden: true },
    attempts: { type: OptionType.NUMBER, default: 0, hidden: true },
    delayUntil: { type: OptionType.NUMBER, default: 0, hidden: true }
} as any);

const hasPasscode = () => !!settings.store.hash;

function savePasscode(code: string) {
    hashCode(code).then(hashed => {
        settings.store.hash = hashed.hash;
        settings.store.salt = hashed.salt;
        settings.store.iterations = hashed.iterations;
        showToast("Passcode has been updated!", Toasts.Type.SUCCESS);
    });
}

// --- Locked chats and servers -------------------------------------------------

interface Scopes {
    channels: Record<string, true>;
    guilds: Record<string, true>;
}

const SCOPES_KEY = "passcodeLock.scopes";

let scopes: Scopes = { channels: {}, guilds: {} };
let scopesLoaded = false;
const scopeListeners = new Set<() => void>();

/** Redraw the settings list after a lock is added or removed. */
function notifyScopesChanged() {
    for (const listener of scopeListeners) listener();
}

function useScopesSnapshot() {
    const [, forceUpdate] = useState(0);
    useEffect(() => {
        const listener = () => forceUpdate(n => n + 1);
        scopeListeners.add(listener);
        return () => void scopeListeners.delete(listener);
    }, []);
    return scopes;
}
/** Scope unlocked for the current visit; cleared once you navigate elsewhere. */
let unlockedScope: string | null = null;
/** Last channel that was not behind a lock, used when a prompt is cancelled. */
let lastAllowedChannelId: string | null = null;

async function loadScopes() {
    try {
        const stored = await DataStore.get<Scopes>(SCOPES_KEY);
        scopes = {
            channels: stored?.channels ?? {},
            guilds: stored?.guilds ?? {}
        };
    } catch (e) {
        logger.warn("loading locked chats and servers failed", e);
    }
    scopesLoaded = true;
}

function saveScopes(): Promise<void> {
    return DataStore.set(SCOPES_KEY, scopes);
}

/** The lock covering a channel, if any: a channel lock wins over its server's. */
function channelScopeKey(channelId?: string | null, guildId?: string | null): string | null {
    if (!channelId) return null;
    if (scopes.channels[channelId]) return `channel:${channelId}`;
    if (guildId && scopes.guilds[guildId]) return `guild:${guildId}`;
    return null;
}

/** Readable name for a channel, DM or group DM; null when it cannot be resolved yet. */
function channelDisplayName(channel: any): string | null {
    if (!channel) return null;
    if (channel.name) return channel.guild_id ? `#${channel.name}` : channel.name;

    const recipients: string[] = channel.recipients ?? [];
    const names = recipients
        .map((id: string) => {
            const user = UserStore.getUser(id) as { globalName?: string; username?: string; } | undefined;
            return user?.globalName ?? user?.username;
        })
        .filter(Boolean);

    return names.length ? names.join(", ") : null;
}

function scopeLabel(key: string): string {
    const [kind, id] = key.split(":");
    if (kind === "guild") return GuildStore.getGuild(id)?.name ?? `server ${id}`;
    return channelDisplayName(ChannelStore.getChannel(id)) ?? `chat ${id}`;
}

async function unlockScope(kind: "channel" | "guild", id: string) {
    const key = `${kind}:${id}`;
    if (kind === "channel") delete scopes.channels[id];
    else delete scopes.guilds[id];

    await saveScopes();

    if (unlockedScope === key) unlockedScope = null;
    if (V1Plugin.gateScope === key) V1Plugin.closeGate();
    notifyScopesChanged();
    showToast(`Unlocked ${scopeLabel(key)}`, Toasts.Type.SUCCESS);
    V1Plugin.refreshScopeGate();
}

function LockedScopeRow({ kind, id }: { kind: "channel" | "guild"; id: string; }) {
    return (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 14 }}>
                {scopeLabel(`${kind}:${id}`)}
                <span style={{ opacity: 0.6 }}> ({kind === "guild" ? "server" : "chat"})</span>
            </span>
            <Button
                size={Button.Sizes.SMALL}
                color={Button.Colors.RED}
                onClick={() => void unlockScope(kind, id)}
            >
                Unlock
            </Button>
        </div>
    );
}

function LockedScopesList() {
    useScopesSnapshot();

    const guildIds = Object.keys(scopes.guilds);
    const channelIds = Object.keys(scopes.channels);

    if (!guildIds.length && !channelIds.length) {
        return (
            <div style={{ fontSize: 14, opacity: 0.75 }}>
                Nothing is locked. Right-click a chat and choose "Lock This Chat", or a server and choose "Lock This Server".
            </div>
        );
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {guildIds.map(id => <LockedScopeRow key={`guild:${id}`} kind="guild" id={id} />)}
            {channelIds.map(id => <LockedScopeRow key={`channel:${id}`} kind="channel" id={id} />)}
        </div>
    );
}

const { selectChannel } = findByPropsLazy("selectChannel");

function goBackFromGate() {
    const target = lastAllowedChannelId;
    if (!target || target === SelectedChannelStore.getChannelId()) return;
    const channel = ChannelStore.getChannel(target);
    if (!channel) return;
    try {
        selectChannel(channel.guild_id ?? null, target);
    } catch (e) {
        logger.warn("navigating back from a locked chat failed", e);
    }
}

// --- Lock screen component ----------------------------------------------------

const MAX_CODE_LENGTH = 15;

// Applied inline to the lock container. The managed stylesheet is the normal source
// of these rules, but inlining them means the overlay still covers Discord if the
// stylesheet is deleted from the element inspector.
const LOCK_MOUNT_STYLE =
    "position: fixed; inset: 0; z-index: 2999; overflow: hidden; user-select: none;"
    + " display: flex; align-items: center; justify-content: center;"
    + " background-color: rgb(0 0 0 / 50%); backdrop-filter: blur(30px);";

function PasscodeLocker({ mode, title, onUnlock, onCancel }: {
    mode: "default" | "editor";
    title?: string;
    onUnlock: (newCode?: string) => void;
    onCancel: () => void;
}) {
    const [code, setCode] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [delayLeft, setDelayLeft] = useState(0);
    const newCode = useRef<string | null>(null);

    const len = codeLength();

    const handleDelay = () => {
        const left = Math.ceil((settings.store.delayUntil - Date.now()) / 1000);
        setDelayLeft(Math.max(0, left));
    };

    useEffect(() => {
        handleDelay();
        const interval = setInterval(handleDelay, 1000);

        const onKey = (e: KeyboardEvent) => {
            if (delayLeft > 0) return;
            if (!isNaN(+e.key) && e.key !== " ") append(+e.key);
            else if (e.key === "Backspace") setCode(c => c.slice(0, -1));
            else if (e.key === "Enter") accept();
            else if (e.key === "Escape") onCancel();
        };
        window.addEventListener("keyup", onKey);
        return () => {
            clearInterval(interval);
            window.removeEventListener("keyup", onKey);
        };
    }, [delayLeft, code]);

    async function submit() {
        if (mode === "editor") {
            if (!confirm) {
                newCode.current = code;
                setCode("");
                setConfirm(true);
            } else if (code === newCode.current) {
                onUnlock(newCode.current!);
            } else {
                fail();
            }
            return;
        }

        if (await hashCheck(code, {
            hash: settings.store.hash,
            salt: settings.store.salt,
            iterations: settings.store.iterations
        })) {
            settings.store.attempts = 0;
            settings.store.delayUntil = 0;
            onUnlock();
        } else {
            fail();
        }
    }

    function fail() {
        setCode("");
        if (mode !== "default") return;

        const attempts = (settings.store.attempts ?? 0) + 1;
        settings.store.attempts = attempts;
        if (attempts >= 3) {
            settings.store.delayUntil = Date.now() + Math.min(30000, 5000 * (attempts - 2));
            handleDelay();
        }
    }

    function append(num: number) {
        if (code.length >= MAX_CODE_LENGTH) return;
        const next = code + num.toString();
        setCode(next);
        if (len !== -1 && len <= next.length) setTimeout(() => submitRef.current?.(), 0);
    }

    // keep submit accessible from the auto-submit timeout
    const submitRef = useRef<() => void>(submit);
    submitRef.current = submit;

    function accept() {
        if (code === "") return;
        submit();
    }

    const btns = ["", "ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"];

    return (
        <div className="v1-pcl-layout">
            <div style={{ position: "relative" }}>
                <div className="v1-pcl-header">
                    <div className="v1-pcl-title">
                        {title ?? (mode === "editor"
                            ? (!confirm ? "Enter your new passcode" : "Re-enter your passcode")
                            : "Enter your Discord passcode")}
                    </div>
                    <div className="v1-pcl-dots">
                        {Array(MAX_CODE_LENGTH).fill(null).map((_, i) => (
                            <div key={i} className={"v1-pcl-dot" + (i < code.length ? " v1-pcl-dot-active" : "")} />
                        ))}
                    </div>
                </div>
                {delayLeft > 0 && (
                    <div className="v1-pcl-delay">
                        Too many tries.
                        {"\n"}Please try again in {delayLeft} {delayLeft > 1 ? "seconds" : "second"}.
                    </div>
                )}
                <div className="v1-pcl-buttons">
                    {btns.map((dec, i) => (
                        <div key={i} className="v1-pcl-btn" onClick={() => append(i + 1)}>
                            <div className="v1-pcl-btn-number">{i + 1}</div>
                            {dec && <div className="v1-pcl-btn-dec">{dec}</div>}
                        </div>
                    ))}
                    <div className="v1-pcl-btn" onClick={() => (code ? accept() : onCancel())}>⏎</div>
                    <div className="v1-pcl-btn" onClick={() => append(0)}>
                        <div className="v1-pcl-btn-number">0</div>
                        <div className="v1-pcl-btn-dec">+</div>
                    </div>
                    <div className="v1-pcl-btn" onClick={() => setCode(c => c.slice(0, -1))}>⌫</div>
                </div>
            </div>
        </div>
    );
}

// --- Overlay mounting ---------------------------------------------------------

interface LockOverlay {
    destroy(): void;
}

function mountLockOverlay(opts: {
    mode: "default" | "editor";
    title?: string;
    onUnlock: (newCode?: string) => void;
    onCancel: () => void;
}): LockOverlay {
    // The lock screen is styled by the plugin's managed stylesheet; make sure it is
    // applied even when the passcode is being set with the plugin toggled off.
    enableStyle(managedStyle);

    const root = document.createElement("div");
    root.className = "v1-pcl-mount";
    root.style.cssText = LOCK_MOUNT_STYLE;
    document.body.appendChild(root);
    // Read the style back: the engine normalises the declaration, so comparisons
    // must use its serialisation rather than the literal above.
    const mountStyle = root.style.cssText;

    let destroyed = false;

    createRoot(root).render(
        React.createElement(PasscodeLocker as any, {
            mode: opts.mode,
            title: opts.title,
            onUnlock: (code?: string) => {
                if (!destroyed) opts.onUnlock(code);
            },
            onCancel: () => {
                if (!destroyed) opts.onCancel();
            }
        })
    );

    // Keys typed at the lock screen belong to the lock screen. Letting them through
    // typed the digits into the chat box behind the overlay, and Enter sent them.
    // Capture phase on window stops them before Discord's own handlers see them.
    const blockKeys = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };
    window.addEventListener("keydown", blockKeys, true);

    // Re-assert the lock whenever the overlay or its stylesheet is tampered with,
    // so deleting the element from the inspector does not reveal Discord.
    const enforce = () => {
        if (destroyed) return;

        if (!root.isConnected) document.body.appendChild(root);
        if (root.className !== "v1-pcl-mount") root.className = "v1-pcl-mount";
        if (root.style.cssText !== mountStyle) root.style.cssText = mountStyle;
        if (root.hasAttribute("hidden")) root.removeAttribute("hidden");

        if (!isStyleEnabled(managedStyle)) enableStyle(managedStyle);
    };

    // Only the body's child list is observed: watching the container's own style
    // attribute would let a correction schedule the next one. Attribute tampering
    // is undone by the watchdog instead, which is rate limited by its interval.
    const observer = new MutationObserver(enforce);
    observer.observe(document.body, { childList: true });
    const watchdog = setInterval(enforce, 250);

    return {
        destroy() {
            destroyed = true;
            observer.disconnect();
            clearInterval(watchdog);
            window.removeEventListener("keydown", blockKeys, true);
            root.remove();
        }
    };
}

// --- Context menu entries -----------------------------------------------------

interface MenuChannel {
    id: string;
    name?: string;
    type?: number;
    guild_id?: string | null;
    recipients?: string[];
}

function isDmChannel(channel: MenuChannel) {
    return channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM;
}

function buildChannelLockItem(channel: MenuChannel) {
    const isLocked = !!scopes.channels[channel.id];
    const label = channelDisplayName(channel) ?? "this chat";

    return (
        <Menu.MenuItem
            id="v1-passcode-lock-chat"
            label={isLocked ? "Unlock This Chat" : "Lock This Chat"}
            action={() => {
                if (!isLocked && !hasPasscode()) {
                    return void showToast("Set a passcode in the PasscodeLock settings before locking chats or servers.", Toasts.Type.FAILURE);
                }

                if (isLocked) delete scopes.channels[channel.id];
                else scopes.channels[channel.id] = true;

                void saveScopes()
                    .then(() => {
                        showToast(`${isLocked ? "Unlocked" : "Locked"} ${label}`, Toasts.Type.SUCCESS);
                        notifyScopesChanged();
                        V1Plugin.refreshScopeGate();
                    })
                    .catch(e => logger.warn("saving a locked chat failed", e));
            }}
        />
    );
}

const channelContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: MenuChannel; }) => {
    if (!channel?.id) return;

    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(buildChannelLockItem(channel));
};

/** DMs and group DMs hang off the user and group-DM menus instead of the channel menu. */
const dmContextPatch: NavContextMenuPatchCallback = (children, { channel }: { channel?: MenuChannel; }) => {
    if (!channel?.id || !isDmChannel(channel)) return;

    const group = findGroupChildrenByChildId(["close-dm", "leave-channel"], children);
    if (!group) return;

    const anchor = group.findIndex(c => c?.props?.id === "close-dm" || c?.props?.id === "leave-channel");
    group.splice(anchor === -1 ? group.length : anchor, 0, buildChannelLockItem(channel));
};

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: { id: string | number; name?: string; }; }) => {
    if (guild?.id == null) return;

    const id = String(guild.id);
    const isLocked = !!scopes.guilds[id];
    const group = findGroupChildrenByChildId("privacy", children) ?? children;

    group.push(
        <Menu.MenuItem
            id="v1-passcode-lock-guild"
            label={isLocked ? "Unlock This Server" : "Lock This Server"}
            action={() => {
                if (!isLocked && !hasPasscode()) {
                    return void showToast("Set a passcode in the PasscodeLock settings before locking chats or servers.", Toasts.Type.FAILURE);
                }

                if (isLocked) delete scopes.guilds[id];
                else scopes.guilds[id] = true;

                void saveScopes()
                    .then(() => {
                        showToast(`${isLocked ? "Unlocked" : "Locked"} ${guild.name ?? "this server"}`, Toasts.Type.SUCCESS);
                        if (!isLocked) unlockedScope = null;
                        notifyScopesChanged();
                        V1Plugin.refreshScopeGate();
                    })
                    .catch(e => logger.warn("saving a locked server failed", e));
            }}
        />
    );
};

// --- Plugin --------------------------------------------------------------------

const V1Plugin = {
    name: "PasscodeLock",
    description: "Protect your Discord with a passcode, and lock individual chats or servers behind it. Converted from the BetterDiscord plugin by arg0NNY.",
    tags: ["Utility", "Privacy"],
    authors: [Devs.Limey],
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Adds the lock entries to chat and server context menus.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Stores a salted hash of your passcode and the list of locked chats and servers locally.",
            risk: "Data persists on your device between sessions."
        }
    ],
    settings,

    managedStyle,

    toolboxActions: {
        "Lock Discord": () => V1Plugin.lock()
    },

    settingsAboutComponent: () => {
        // Read the store reactively so the label updates after setting a passcode
        const { hash } = (settings as any).use(["hash"]);
        return (
            <Button
                onClick={() => (V1Plugin as any).lock(hash ? "default" : "editor")}
            >
                {hash ? "Change Passcode" : "Set Passcode"}
            </Button>
        );
    },

    locked: false,
    overlay: null as LockOverlay | null,
    gateOverlay: null as LockOverlay | null,
    gateScope: null as string | null,
    keybindHandler: null as ((e: KeyboardEvent) => void) | null,
    blurListener: null as (() => void) | null,
    focusListener: null as (() => void) | null,
    autolockTimeout: undefined as ReturnType<typeof setTimeout> | undefined,

    lock(mode: "default" | "editor" = "default") {
        // Clean up any stale lock state from a previous failed attempt
        if (this.locked) this.unlock();
        if (!hasPasscode() && mode === "default") {
            return void showToast("Please first set up the passcode in the plugin settings.", Toasts.Type.FAILURE);
        }

        this.closeGate();
        this.locked = true;
        settings.store.locked = true;

        this.overlay = mountLockOverlay({
            mode,
            onUnlock: (code?: string) => {
                if (code) savePasscode(code);
                this.unlock();
            },
            onCancel: () => this.unlock()
        });
    },

    unlock() {
        this.locked = false;
        settings.store.locked = false;
        settings.store.attempts = 0;
        settings.store.delayUntil = 0;

        this.overlay?.destroy();
        this.overlay = null;
    },

    /** Prompt for the passcode when the current chat sits behind a lock. */
    openGate(key: string) {
        if (this.locked || this.gateOverlay) return;
        if (!hasPasscode()) {
            return void showToast("Set a passcode in the PasscodeLock settings before locking chats or servers.", Toasts.Type.FAILURE);
        }

        this.gateScope = key;
        this.gateOverlay = mountLockOverlay({
            mode: "default",
            title: `${scopeLabel(key)} is locked`,
            onUnlock: () => {
                unlockedScope = key;
                this.closeGate();
            },
            onCancel: () => {
                this.closeGate();
                unlockedScope = null;
                goBackFromGate();
            }
        });
    },

    closeGate() {
        this.gateOverlay?.destroy();
        this.gateOverlay = null;
        this.gateScope = null;
    },

    /** Open or close the prompt to match whatever chat is on screen right now. */
    refreshScopeGate() {
        const channelId = SelectedChannelStore.getChannelId() ?? null;
        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const key = channelScopeKey(channelId, channel?.guild_id);

        if (!key) {
            this.closeGate();
            return;
        }
        if (this.locked || this.gateScope === key) return;
        this.openGate(key);
    },

    flux: {
        CHANNEL_SELECT({ channelId }: { channelId?: string | null; }) {
            if (!scopesLoaded || !channelId) return;

            const channel = ChannelStore.getChannel(channelId);
            const key = channelScopeKey(channelId, channel?.guild_id);

            if (!key) {
                lastAllowedChannelId = channelId;
                unlockedScope = null;
                V1Plugin.closeGate();
                return;
            }

            if (key === unlockedScope) return;
            if (V1Plugin.locked || V1Plugin.gateOverlay) return;
            V1Plugin.openGate(key);
        }
    },

    contextMenus: {
        "channel-context": channelContextPatch,
        "thread-context": channelContextPatch,
        "user-context": dmContextPatch,
        "gdm-context": dmContextPatch,
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch
    },

    async start() {
        const kb = (settings.store.lockKeybind || "control+l").toLowerCase().split("+");

        this.keybindHandler = (e: KeyboardEvent) => {
            const pressed = [
                e.ctrlKey && "control",
                e.shiftKey && "shift",
                e.altKey && "alt",
                e.metaKey && "meta",
                e.key.toLowerCase()
            ].filter(Boolean);
            if (kb.every(k => pressed.includes(k)) && pressed.length === kb.length) this.lock();
        };
        window.addEventListener("keydown", this.keybindHandler);

        this.blurListener = () => {
            const { autolock } = settings.store;
            if (!autolock) return;
            this.autolockTimeout = setTimeout(() => this.lock(), autolock * 1000);
        };
        this.focusListener = () => clearTimeout(this.autolockTimeout);
        window.addEventListener("blur", this.blurListener);
        window.addEventListener("focus", this.focusListener);

        await loadScopes();
        lastAllowedChannelId = SelectedChannelStore.getChannelId() ?? null;

        if (hasPasscode() && (settings.store.lockOnStartup || settings.store.locked)) {
            setTimeout(() => this.lock());
        } else {
            this.refreshScopeGate();
        }
    },

    stop() {
        this.unlock();
        this.closeGate();
        if (this.keybindHandler) window.removeEventListener("keydown", this.keybindHandler);
        clearTimeout(this.autolockTimeout);
        window.removeEventListener("blur", this.blurListener!);
        window.removeEventListener("focus", this.focusListener!);

        unlockedScope = null;
        lastAllowedChannelId = null;
    }
};

export default definePlugin(V1Plugin as any);

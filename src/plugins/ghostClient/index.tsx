/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { isPluginEnabled, plugins } from "@api/PluginManager";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { showToast, Toasts, UserStore } from "@webpack/common";

// Same backend as the other Limey V1 plugins (limey-discord.onrender.com).
const API_URL = "https://limey-discord.onrender.com/v1/ghost";
// The backend prunes sessions after 90s; the plugin pings every 30s (3 misses).
const PING_INTERVAL_MS = 30 * 1000;
// Cap relayed to match the server's GHOST_MAX_ANCHORS.
const MAX_ANCHORS = 48;

export const settings = definePluginSettings({
    ghostOnly: {
        type: OptionType.BOOLEAN,
        description: "Render relayed effects ONLY on the Ghost Client overlay — hide them inside Discord while the overlay is connected",
        default: true
    },
    notifyConnect: {
        type: OptionType.BOOLEAN,
        description: "Show a toast inside Discord when the Ghost Client app connects or disconnects",
        default: true
    }
});

let ghostAppOnline = false;

/**
 * Plugins call this to know whether their visual effect should currently be
 * hidden inside Discord and rendered by the Ghost Client overlay instead
 * (e.g. ForceOwnerCrown standing down while the EXE shows the crown).
 */
export function shouldHideInDiscord() {
    return ghostAppOnline && settings.store.ghostOnly;
}

export function isGhostAppOnline() {
    return ghostAppOnline;
}

interface VisualPluginFlag {
    /** Plugin name in @api/PluginManager */
    id: string;
    /** Short label shown in the Ghost Client app */
    label: string;
    /** The icon the Ghost Client overlay renders when this is on */
    flag: string;
}

/**
 * Visual plugins the Ghost Client overlay can render instead of (or on top of)
 * Discord itself. The plugin relays which of these are enabled; the overlay
 * app draws the corresponding GUI so the effect "lives" in the EXE window
 * floating above Discord, not inside the Discord client.
 */
const VISUAL_PLUGINS: VisualPluginFlag[] = [
    { id: "ForceOwnerCrown", label: "Force Owner Crown", flag: "crown" },
    { id: "FriendshipRanks", label: "Friendship Ranks", flag: "ranks" },
    { id: "Streaks", label: "Streaks", flag: "streak" },
    { id: "WigglyText", label: "Wiggly Text", flag: "wiggly" },
    { id: "CallTimer", label: "Call Timer", flag: "timer" },
];

export interface GhostClientState {
    userId: string;
    username: string;
    displayName: string | null;
    /** Names of all enabled Limey V1 plugins */
    enabledPlugins: string[];
    /** Overlay flags: which visual effects the EXE app should draw */
    flags: Record<string, boolean>;
}

/** One relayed effect placeholder, in Discord viewport coordinates (CSS px). */
interface GhostAnchor {
    effect: string;
    userId: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

interface GhostViewport {
    dpr: number;
    vw: number;
    vh: number;
}

/**
 * Visual plugins drop invisible `[data-limey-ghost-anchor]` markers into the
 * Discord DOM exactly where their effect would render (e.g. ForceOwnerCrown
 * puts one in the guild owner's member-list row). We measure those markers
 * and relay their live position so the Ghost Client EXE can draw the effect
 * ESP-style, directly on top of the right Discord UI element.
 */
function collectAnchors(): { anchors: GhostAnchor[]; viewport: GhostViewport; } {
    const anchors: GhostAnchor[] = [];

    if (typeof document !== "undefined") {
        for (const el of document.querySelectorAll("[data-limey-ghost-anchor]")) {
            const effect = el.getAttribute("data-limey-ghost-anchor");
            const userId = el.getAttribute("data-user-id") ?? "";
            if (!effect || !/^\d+$/.test(userId)) continue;

            // getBoundingClientRect keeps the geometry of visibility:hidden
            // elements (unlike display:none), so zero-width marker spans work.
            const r = el.getBoundingClientRect();
            if (!r || (r.x === 0 && r.y === 0 && !r.width && !r.height)) continue; // detached

            anchors.push({
                effect,
                userId,
                x: Math.round(r.x * 10) / 10,
                y: Math.round(r.y * 10) / 10,
                w: Math.round(r.width * 10) / 10,
                h: Math.round(r.height * 10) / 10,
            });
            if (anchors.length >= MAX_ANCHORS) break;
        }
    }

    return {
        anchors,
        viewport: {
            dpr: window.devicePixelRatio || 1,
            vw: window.innerWidth,
            vh: window.innerHeight,
        },
    };
}

let lastAnchorSignature = "";
let lastPushHadAnchors = false;

/**
 * ESP fast lane: push fresh anchor positions to the relay so the EXE can draw
 * the effects at their exact spot while the member list scrolls. Only pushes
 * when something actually changed (plus one clearing push when the last
 * anchors disappear).
 */
async function pushAnchors(myId: string) {
    const { anchors, viewport } = collectAnchors();
    const signature = JSON.stringify([anchors, viewport]);
    if (signature === lastAnchorSignature) return;
    lastAnchorSignature = signature;

    // Only clear when there is something stale to clear; never spam empty pushes.
    if (!anchors.length && !lastPushHadAnchors) return;
    lastPushHadAnchors = anchors.length > 0;

    try {
        await fetch(`${API_URL}/anchors`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: myId, anchors, viewport }),
        });
    } catch (e) {
        console.error("[GhostClient] anchor push failed:", e);
    }
}

function collectClientState() {
    const me = UserStore.getCurrentUser();
    const enabledPlugins: string[] = [];
    const flags: Record<string, boolean> = {};

    for (const plugin of Object.values(plugins)) {
        const enabled = isPluginEnabled(plugin.name);
        if (!enabled || plugin.name?.startsWith("_")) continue;
        enabledPlugins.push(plugin.name!);
    }
    // isPluginEnabled takes the plugin NAME, not the plugin object
    for (const visual of VISUAL_PLUGINS) {
        flags[visual.flag] = isPluginEnabled(visual.id);
    }

    return {
        userId: String(me?.id ?? ""),
        username: String(me?.username ?? ""),
        displayName: (me as any)?.globalName ?? (me as any)?.displayName ?? null,
        enabledPlugins,
        flags,
        ...collectAnchors(),
    };
}

const GhostBadge: ProfileBadge = {
    key: "limeyGhostClient",
    id: "ghost_client",
    description: "Ghost Client overlay running",
    iconSrc: "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><text x="0" y="13" font-size="13">👻</text></svg>'
    ),
    position: BadgePosition.END,
    shouldShow({ userId }: { userId: string; }) {
        return userId === UserStore.getCurrentUser()?.id && ghostAppOnline;
    }
};

interface PingResponse {
    appOnline: boolean;
}

export default definePlugin({
    name: "Ghost Client",
    description: "Reports your plugin state to the Ghost Client overlay app: the EXE floats above Discord and renders the GUI (like a Prestige-style ghost client) for the visual plugins you have enabled — the actions and effects still come from Limey V1 installed in Discord. In ghost-only mode the effects are drawn ESP-style at their exact spots in the Discord UI.",
    tags: ["Utility"],
    authors: [Devs.Limey],

    settings,

    intervalId: undefined as ReturnType<typeof setInterval> | undefined,
    anchorTimerId: undefined as ReturnType<typeof setInterval> | undefined,

    start() {
        addProfileBadge(GhostBadge);
        this.ping();
        this.intervalId = setInterval(() => this.ping(), PING_INTERVAL_MS);

        this.anchorTimerId = setInterval(() => {
            const me = UserStore.getCurrentUser();
            if (me) void pushAnchors(me.id);
        }, 1000);
    },

    stop() {
        removeProfileBadge(GhostBadge);
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = undefined;
        if (this.anchorTimerId) clearInterval(this.anchorTimerId);
        this.anchorTimerId = undefined;
        ghostAppOnline = false;
    },

    async ping() {
        const me = UserStore.getCurrentUser();
        if (!me) return; // not logged in yet; the interval retries

        const state = collectClientState();

        try {
            const res = await fetch(`${API_URL}/ping`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...state,
                    userId: me.id,
                })
            });
            if (!res.ok) throw new Error(`Ghost relay responded ${res.status}`);
            const data: PingResponse = await res.json();

            const wasOnline = ghostAppOnline;
            ghostAppOnline = Boolean(data.appOnline);

            if (settings.store.notifyConnect && wasOnline !== ghostAppOnline) {
                showToast(
                    ghostAppOnline ? "👻 Ghost Client overlay connected" : "Ghost Client overlay disconnected",
                    ghostAppOnline ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
                );
            }
        } catch (e) {
            console.error("[GhostClient] ping failed:", e);
        }
    }
});

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

export const settings = definePluginSettings({
    notifyConnect: {
        type: OptionType.BOOLEAN,
        description: "Show a toast inside Discord when the Ghost Client app connects or disconnects",
        default: true
    }
});

let ghostAppOnline = false;

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

function collectClientState(): GhostClientState {
    const me = UserStore.getCurrentUser();
    const enabledPlugins: string[] = [];
    const flags: Record<string, boolean> = {};

    for (const plugin of Object.values(plugins)) {
        const enabled = isPluginEnabled(plugin.name);
        if (!enabled || plugin.name?.startsWith("_")) continue;
        enabledPlugins.push(plugin.name!);
    }
    for (const visual of VISUAL_PLUGINS) {
        flags[visual.flag] = Object.values(plugins).some(
            (plugin: any) => plugin.name === visual.id && isPluginEnabled(plugin)
        );
    }

    return {
        userId: String(me?.id ?? ""),
        username: String(me?.username ?? ""),
        displayName: (me as any)?.globalName ?? (me as any)?.displayName ?? null,
        enabledPlugins,
        flags,
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
    description: "Reports your plugin state to the Ghost Client overlay app: the EXE floats above Discord and renders the GUI (like a Prestige-style ghost client) for the visual plugins you have enabled — the actions and effects still come from Limey V1 installed in Discord.",
    tags: ["Utility"],
    authors: [Devs.Limey],

    settings,

    intervalId: undefined as ReturnType<typeof setInterval> | undefined,

    start() {
        addProfileBadge(GhostBadge);
        this.ping();
        this.intervalId = setInterval(() => this.ping(), PING_INTERVAL_MS);
    },

    stop() {
        removeProfileBadge(GhostBadge);
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = undefined;
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

/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelRouter, ChannelStore, GuildStore, MessageActions, MessageStore, NavigationRouter, SelectedChannelStore, showToast, Toasts, UserStore } from "@webpack/common";
import type { User } from "@limeyV1/discord-types";

// Same backend as the other Limey V1 plugins (limey-discord.onrender.com).
const API_URL = "https://limey-discord.onrender.com/v1/ghost";
// The backend prunes sessions after 90s; the plugin pings every 30s (3 misses).
const PING_INTERVAL_MS = 30 * 1000;
// Keep the HTTP payload small per ping.
const MAX_SNAPSHOT_MESSAGES = 15;
const MAX_MESSAGE_CHARS = 400;
// Never replay stale actions if the ping was delayed.
const COMMAND_MAX_AGE_MS = PING_INTERVAL_MS * 4;
const MAX_COMMAND_QUEUE = 25;

export const settings = definePluginSettings({
    mirrorMessages: {
        type: OptionType.BOOLEAN,
        description: "Send a small snapshot of the current channel's recent messages (author + text) to the Ghost Client app",
        default: true
    },
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

interface SnapshotMessage {
    id: string;
    author: string;
    content: string;
    ts: number | null;
}

interface GhostCommand {
    id: number;
    action: string;
    args: Record<string, any>;
    createdAt?: number;
}

interface PingResponse {
    appOnline: boolean;
    commands: GhostCommand[];
}

const GhostBadge: ProfileBadge = {
    key: "limeyGhostClient",
    id: "ghost_client",
    description: "Ghost Client app running",
    iconSrc: "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><text x="0" y="13" font-size="13">👻</text></svg>'
    ),
    position: BadgePosition.END,
    shouldShow({ userId }: { userId: string; }) {
        return userId === UserStore.getCurrentUser()?.id && ghostAppOnline;
    }
};

function getStoredMessages(channelId: string): any[] {
    try {
        const cached = MessageStore.getMessages(channelId) as any;
        if (!cached) return [];
        if (Array.isArray(cached)) return cached;
        // MessageCache shape: ids (ordered) + _map (id -> message)
        if (Array.isArray(cached.ids) && cached._map instanceof Map) {
            return cached.ids.map((id: string) => cached._map.get(id)).filter(Boolean);
        }
        if (typeof cached.getArray === "function") return cached.getArray();
        return [];
    } catch {
        return [];
    }
}

function buildSnapshot(): { channelName: string | null; messages: SnapshotMessage[] } {
    const channelId = String(SelectedChannelStore.getChannelId() ?? "");
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    if (!channel) return { channelName: null, messages: [] };

    const guildId = (channel as any).guild_id;
    const guildName = guildId ? GuildStore.getGuild(guildId)?.name : null;
    const channelName = guildName
        ? `${(channel as any).name} — ${guildName}`
        : (channel as any).name ?? "Direct Messages";

    const messages: SnapshotMessage[] = [];
    for (const m of getStoredMessages(channelId).slice(-MAX_SNAPSHOT_MESSAGES)) {
        const author = m?.author as unknown as User | undefined;
        const ts = m?.timestamp ? new Date(m.timestamp as any).getTime() : null;
        messages.push({
            id: String(m?.id ?? ""),
            author: author ? String(author.username ?? author.id ?? "?") : "?",
            content: String(m?.content ?? "").slice(0, MAX_MESSAGE_CHARS),
            ts: Number.isFinite(ts as any) ? ts : null,
        });
    }

    return { channelName, messages };
}

function serializeSnapshotMessages(messages: SnapshotMessage[]) {
    // Trim fields for the wire, oldest-first like Discord's own history view.
    return messages.map(m => ({
        id: m.id,
        author: m.author,
        content: m.content,
        ts: m.ts,
    }));
}

/** Called with each queued action coming back from the Ghost Client app. */
export async function executeGhostCommand(cmd: GhostCommand) {
    const args = (cmd.args ?? {}) as Record<string, any>;
    switch (cmd.action) {
        case "sendMessage": {
            const channelId = String(args.channelId || SelectedChannelStore.getChannelId() || "");
            if (!channelId || !args.content) return;
            await MessageActions.sendMessage(channelId, { content: String(args.content) }, true, undefined);
            break;
        }
        case "openChannel": {
            const channelId = String(args.channelId || "");
            const channel = channelId ? ChannelStore.getChannel(channelId) as any : null;
            if (!channel) return;
            if (channel.guild_id) NavigationRouter.transitionTo(`/channels/${channel.guild_id}/${channelId}`);
            else ChannelRouter.transitionToChannel(channelId);
            break;
        }
        case "openGuild": {
            const guildId = String(args.guildId || "");
            if (guildId) NavigationRouter.transitionToGuild(guildId);
            break;
        }
        default:
            console.warn("[GhostClient] unknown command:", cmd.action);
    }
}

export function pruneCommandQueue(queue: GhostCommand[]): GhostCommand[] {
    const now = Date.now();
    const fresh = queue.filter(cmd => (cmd.createdAt ?? 0) <= now && now - (cmd.createdAt ?? 0) < COMMAND_MAX_AGE_MS);
    return fresh.slice(-MAX_COMMAND_QUEUE);
}

export default definePlugin({
    name: "Ghost Client",
    description: "Displays a \"Ghost Client running\" badge while the Limey V1 Ghost Client app is open: the app mirrors the Discord GUI remotely while every action still executes normally inside Discord, where Limey V1 is installed.",
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

        const body: Record<string, unknown> = {
            userId: me.id,
            username: me.username,
            displayName: (me as any).globalName ?? (me as any).displayName ?? null,
        };
        if (settings.store.mirrorMessages) {
            const snapshot = buildSnapshot();
            body.channelName = snapshot.channelName;
            body.messages = serializeSnapshotMessages(snapshot.messages);
        }

        try {
            const res = await fetch(`${API_URL}/ping`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error(`Ghost relay responded ${res.status}`);
            const data: PingResponse = await res.json();

            const wasOnline = ghostAppOnline;
            ghostAppOnline = Boolean(data.appOnline);

            if (settings.store.notifyConnect && wasOnline !== ghostAppOnline) {
                showToast(
                    ghostAppOnline ? "👻 Ghost Client app connected" : "Ghost Client app disconnected",
                    ghostAppOnline ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE
                );
            }

            for (const cmd of pruneCommandQueue(data.commands ?? [])) {
                try {
                    await executeGhostCommand(cmd);
                } catch (e) {
                    console.error("[GhostClient] command failed:", cmd.action, e);
                }
            }
        } catch (e) {
            console.error("[GhostClient] ping failed:", e);
        }
    }
});

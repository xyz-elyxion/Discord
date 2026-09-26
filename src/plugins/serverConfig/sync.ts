/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { Auth } from "./auth";

export interface RemoteGuildConfig {
    disabledPlugins: string[];
}

const logger = new Logger("ServerConfig");

/**
 * Remote configs fetched from the backend, keyed by guild id.
 * The backend is authoritative: every member's client respects it.
 */
export const remoteCache: Record<string, RemoteGuildConfig> = {};

const BASE = "https://limey-discord.onrender.com";
let refreshTimer: ReturnType<typeof setInterval> | undefined;

async function fetchGuildConfig(guildId: string): Promise<RemoteGuildConfig | null> {
    try {
        const res = await fetch(`${BASE}/v1/server-config/${guildId}`, { cache: "no-cache" });
        if (!res.ok) return null;
        const parsed = await res.json();
        if (typeof parsed === "object" && parsed != null && Array.isArray(parsed.disabledPlugins)) {
            return { disabledPlugins: parsed.disabledPlugins.filter((p: unknown) => typeof p === "string") };
        }
    } catch (err) {
        logger.error("Failed to fetch server config for guild", guildId, err);
    }
    return null;
}

/**
 * Ensures a remote config exists for the guild, fetching it from the backend
 * when it hasn't been cached yet. Returns the merged disabled list:
 * backend config takes priority over any locally stored owner changes.
 */
export async function getRemoteConfig(guildId: string): Promise<RemoteGuildConfig> {
    if (remoteCache[guildId]) return remoteCache[guildId];
    const config = await fetchGuildConfig(guildId);
    if (config) remoteCache[guildId] = config;
    return config ?? { disabledPlugins: [] };
}

/**
 * Pushes an owner's change for a guild to the backend. Requires prior OAuth
 * authorization (the backend verifies Discord guild ownership server-side).
 * Returns an error message on failure, or null on success.
 */
export async function pushGuildConfig(guildId: string, disabledPlugins: string[]): Promise<string | null> {
    try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (Auth.token) headers.Authorization = `Bearer ${Auth.token}`;

        const res = await fetch(`${BASE}/v1/server-config/${guildId}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ disabledPlugins })
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            logger.error("Failed to push server config for guild", guildId, res.status, body?.message);
            return body?.message ?? `HTTP ${res.status}`;
        }
        remoteCache[guildId] = { disabledPlugins };
        return null;
    } catch (err) {
        logger.error("Failed to push server config for guild", guildId, err);
        return String(err);
    }
}

/** Periodically refreshes cached configs so member clients pick up owner changes. */
export function startAutoRefresh(intervalMs = 5 * 60 * 1000) {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
        for (const guildId of Object.keys(remoteCache)) {
            void fetchGuildConfig(guildId).then(config => {
                if (config) remoteCache[guildId] = config;
            });
        }
    }, intervalMs);
}

export function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
}

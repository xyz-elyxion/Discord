/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Guild } from "@limeyV1/discord-types";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, openModal, PermissionsBits, PermissionStore, SelectedGuildStore } from "@webpack/common";

import { ServerConfigModal } from "./ServerConfigModal";
import { getRemoteConfig, pushGuildConfig, remoteCache, startAutoRefresh, stopAutoRefresh } from "./sync";
import { initAuth } from "./auth";

export interface ServerConfigEntry {
    disabledPlugins: string[];
}

export interface ServerConfigStore {
    guilds: Record<string, ServerConfigEntry>;
}

/**
 * Plugins that support being disabled per-server through Server Configuration.
 * A plugin is included here by adding its name to the list.
 */
export const SERVER_CONFIGURABLE_PLUGINS = [
    "ShowHiddenThings",
    "ShowHiddenChannels",
] as const;

export const settings = definePluginSettings({
    guilds: {
        type: OptionType.SELECT,
        description: "Per-server plugin configuration (do not edit manually)",
        hidden: true,
        options: [{
            label: "default",
            value: "",
            default: true
        }]
    }
} as any);

export function getGuildConfig(guildId: string): ServerConfigEntry {
    return settings.store.guilds[guildId] ?? { disabledPlugins: [] };
}

/**
 * Returns whether the given plugin is disabled in the given server.
 * The backend (synced to all members) is authoritative; the local per-guild
 * store is used as a fallback for guilds that haven't been pushed yet.
 */
export function isPluginDisabledInGuild(pluginName: string, guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    const remote = remoteCache[guildId];
    if (remote) return remote.disabledPlugins.includes(pluginName);
    return getGuildConfig(guildId).disabledPlugins.includes(pluginName);
}

/**
 * Async variant that fetches the backend config on first use, so member
 * clients respect the server owner's choice even without any local cache.
 */
export async function ensurePluginDisabledInGuild(pluginName: string, guildId: string | null | undefined): Promise<boolean> {
    if (!guildId) return false;
    if (!remoteCache[guildId]) await getRemoteConfig(guildId);
    return isPluginDisabledInGuild(pluginName, guildId);
}

/** Returns whether the given plugin is disabled in the currently selected server. */
export function isPluginDisabledInSelectedGuild(pluginName: string): boolean {
    return isPluginDisabledInGuild(pluginName, SelectedGuildStore?.getGuildId?.());
}

async function togglePlugin(guildId: string, pluginName: string, value: boolean): Promise<string | null> {
    // Update local store (used as fallback and for offline/unsynced guilds)
    const guilds = { ...settings.store.guilds };
    const entry = { disabledPlugins: [...(guilds[guildId]?.disabledPlugins ?? [])] };

    const idx = entry.disabledPlugins.indexOf(pluginName);
    if (value && idx === -1) entry.disabledPlugins.push(pluginName);
    if (!value && idx !== -1) entry.disabledPlugins.splice(idx, 1);

    guilds[guildId] = entry;
    settings.store.guilds = guilds;

    // Sync to the backend so every member's client respects the choice
    return pushGuildConfig(guildId, entry.disabledPlugins);
}

function openGuildConfigModal(guild: Guild) {
    // Make sure we have the authoritative backend config before editing
    void getRemoteConfig(guild.id);

    openModal(modalProps => (
        <ServerConfigModal
            modalProps={modalProps}
            guild={guild}
            disabledPlugins={getGuildConfig(guild.id).disabledPlugins}
            onToggle={(pluginName, value) => togglePlugin(guild.id, pluginName, value)}
        />
    ));
}

const makePatch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild; }) => {
    if (!guild) return;

    // Only server owners/admins (MANAGE_GUILD) get to configure this
    if (!PermissionStore?.can?.(PermissionsBits?.MANAGE_GUILD ?? 32n, guild)) return;

    children.push(
        <Menu.MenuItem
            id="vc-server-config"
            label="Server Configuration"
            action={() => openGuildConfigModal(guild)}
        />
    );
};

export default definePlugin({
    name: "ServerConfig",
    description: "Lets server owners disable certain Limey V1 plugins for their server via the server context menu. Synced to all members.",
    tags: ["Servers", "Utility"],
    authors: [Devs.Ven],
    settings,

    start() {
        void initAuth();
        startAutoRefresh();
    },

    stop() {
        stopAutoRefresh();
    },

    contextMenus: {
        "guild-context": makePatch,
        "guild-header-popout": makePatch
    }
});

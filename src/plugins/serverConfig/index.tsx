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
 * Returns whether the given plugin is disabled in the given server
 * through Server Configuration. Falls back to false for unknown guilds.
 */
export function isPluginDisabledInGuild(pluginName: string, guildId: string | null | undefined): boolean {
    if (!guildId) return false;
    return getGuildConfig(guildId).disabledPlugins.includes(pluginName);
}

/** Returns whether the given plugin is disabled in the currently selected server. */
export function isPluginDisabledInSelectedGuild(pluginName: string): boolean {
    return isPluginDisabledInGuild(pluginName, SelectedGuildStore?.getGuildId?.());
}

function togglePlugin(guildId: string, pluginName: string, value: boolean) {
    const guilds = { ...settings.store.guilds };
    const entry = { disabledPlugins: [...(guilds[guildId]?.disabledPlugins ?? [])] };

    const idx = entry.disabledPlugins.indexOf(pluginName);
    if (value && idx === -1) entry.disabledPlugins.push(pluginName);
    if (!value && idx !== -1) entry.disabledPlugins.splice(idx, 1);

    guilds[guildId] = entry;
    settings.store.guilds = guilds;
}

function openGuildConfigModal(guild: Guild) {
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
    description: "Lets server owners disable certain Limey V1 plugins for their server via the server context menu",
    tags: ["Servers", "Utility"],
    authors: [Devs.Ven],
    settings,

    contextMenus: {
        "guild-context": makePatch,
        "guild-header-popout": makePatch
    }
});

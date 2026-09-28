/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DataStore } from "@api/index";
import { definePluginSettings, PlainSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { HeadingTertiary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginPermission } from "@utils/types";
import { Alerts } from "@webpack/common";

export const APPROVED_KEY = "PermissionsManagerApproved";

export function getApproved(): string[] {
    return ((PlainSettings.plugins as any)?.PermissionsManager?.approved ?? []) as string[];
}

export function approve(name: string) {
    const approved = new Set(Plain()?.approved ?? []);
    approved.add(name);
    persist([...approved]);
}

export function revoke(name: string) {
    const approved = new Set(Plain()?.approved ?? []);
    approved.delete(name);
    persist([...approved]);
}

function Plain(): { approved?: string[] } {
    return (PlainSettings.plugins as any)?.PermissionsManager ?? {};
}

function persist(approved: string[]) {
    ((PlainSettings.plugins as any).PermissionsManager ??= {}).approved = approved;
}

export function hasApproved(name: string) {
    return getApproved().includes(name);
}

function PermissionEntry({ p }: { p: PluginPermission }) {
    return (
        <Card style={{ marginBottom: "8px", padding: "10px 14px" }}>
            <BaseText style={{ fontWeight: 700 }}>
                {p.title} <span style={{ opacity: 0.6 }}>({p.id})</span>
            </BaseText>
            <Paragraph>{p.description}</Paragraph>
            <Paragraph style={{ color: "#ff7473" }}>Why it can be bad: {p.risk}</Paragraph>
        </Card>
    );
}

export const settings = definePluginSettings({
    requireForAll: {
        type: OptionType.BOOLEAN,
        description: "Show a confirmation even for plugins that declare no permissions (tells you they are unreviewed)",
        default: true
    },
    blockUndeclaredInstalls: {
        type: OptionType.BOOLEAN,
        description: "Block userplugins installed via UserpluginInstaller that do not declare any permissions",
        default: true
    }
});

/**
 * Called by the plugin settings UI (or any other caller) before enabling a plugin.
 * Returns true if enabling may proceed, false if the user declined.
 */
export function confirmEnable(plugin: { name: string; description: string; permissions?: PluginPermission[] }): Promise<boolean> {
    const perms = plugin.permissions ?? [];
    if (perms.length === 0 && !settings.store.requireForAll) return Promise.resolve(true);
    if (perms.length === 0 && hasApproved(plugin.name)) return Promise.resolve(true);
    if (perms.length > 0 && hasApproved(plugin.name)) return Promise.resolve(true);

    return new Promise(resolve => {
        Alerts.show({
            title: `Hold up — ${plugin.name} wants permissions`,
            body: (
                <div>
                    <Paragraph>
                        {plugin.description}
                    </Paragraph>
                    {perms.length > 0 ? (
                        <div>
                            <HeadingTertiary>Requested permissions</HeadingTertiary>
                            {perms.map(p => <PermissionEntry key={p.id} p={p} />)}
                        </div>
                    ) : (
                        <Card style={{ margin: "10px 0", padding: "10px 14px" }}>
                            <Paragraph>
                                This plugin does <b>not</b> declare any permissions. That means it has not been
                                reviewed through the Limey V1 permission system and could do anything a client mod
                                plugin can do — read messages, modify your client, patch Discord internals. Only
                                enable it if you trust the author.
                            </Paragraph>
                        </Card>
                    )}
                </div>
            ),
            confirmText: "Enable plugin",
            cancelText: "Cancel",
            onCancel: () => resolve(false),
            onConfirm: () => {
                approve(plugin.name);
                resolve(true);
            }
        });
    });
}

export default definePlugin({
    name: "PermissionsManager",
    description: "Shows you what permissions a plugin needs, what it does and why that could be bad before you enable it. Also blocks userplugins that do not declare permissions.",
    authors: [Devs.Ven],
    required: true,
    enabledByDefault: true,
    tags: ["Utility"],
    settings,
    async start() {
        const saved = await DataStore.get(APPROVED_KEY);
        if (Array.isArray(saved) && saved.length && getApproved().length === 0) {
            persist(saved as string[]);
        }
    },
    // legacy storage migration hook kept simple: approved list lives in plugin settings
});

export async function migrateLegacy() {
    const saved = await DataStore.get(APPROVED_KEY);
    if (Array.isArray(saved) && saved.length) {
        persist(saved as string[]);
        await DataStore.set(APPROVED_KEY, []);
    }
}

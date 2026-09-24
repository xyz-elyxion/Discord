/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, RestAPI, showToast, Toasts, UserStore } from "@webpack/common";

const enum ChannelType {
    GROUP_DM = 3
}

interface GroupDmChannel {
    id: string;
    type: number;
    recipients?: string[];
    isGroupDM?: () => boolean;
}

interface RecipientEvent {
    channelId: string;
    user: { id: string; };
}

type StoredSnapshots = Record<string, string[]>;

const logger = new Logger("LockGroup");
const snapshots = new Map<string, Set<string>>();
const pendingActions = new Set<string>();

let activeUserId: string | null = null;
let initialization: Promise<void> | null = null;

const settings = definePluginSettings({
    lockEnabled: {
        type: OptionType.BOOLEAN,
        description: "Lock every group DM to its current member list. New members are kicked and removed members are re-added.",
        default: false,
        onChange(enabled: boolean) {
            if (enabled) void resetSnapshots();
        }
    }
});

function isGroupDm(channel: GroupDmChannel | null | undefined): channel is GroupDmChannel {
    return channel?.type === ChannelType.GROUP_DM || channel?.isGroupDM?.() === true;
}

function storageKey(userId: string) {
    return `LockGroup:snapshots:${userId}`;
}

function getGroupDms(): GroupDmChannel[] {
    return (ChannelStore.getSortedPrivateChannels() as GroupDmChannel[])
        .filter(isGroupDm);
}

function snapshotChannel(channel: GroupDmChannel) {
    snapshots.set(channel.id, new Set(channel.recipients ?? []));
}

function serializeSnapshots(): StoredSnapshots {
    return Object.fromEntries(
        [...snapshots].map(([channelId, recipients]) => [channelId, [...recipients]])
    );
}

async function saveSnapshots() {
    if (!activeUserId) return;
    await DataStore.set(storageKey(activeUserId), serializeSnapshots());
}

async function initializeSnapshots() {
    const userId = UserStore.getCurrentUser()?.id;
    if (!userId) return;
    if (activeUserId === userId) return;
    if (initialization) return initialization;

    initialization = (async () => {
        const stored = await DataStore.get<StoredSnapshots>(storageKey(userId));

        snapshots.clear();
        if (stored && typeof stored === "object") {
            for (const [channelId, recipients] of Object.entries(stored)) {
                if (Array.isArray(recipients) && recipients.every(id => typeof id === "string")) {
                    snapshots.set(channelId, new Set(recipients));
                }
            }
        }

        activeUserId = userId;

        let changed = false;
        for (const channel of getGroupDms()) {
            if (!snapshots.has(channel.id)) {
                snapshotChannel(channel);
                changed = true;
            }
        }

        if (changed) await saveSnapshots();
    })().catch(error => {
        logger.error("Failed to load locked member snapshots", error);
    }).finally(() => {
        initialization = null;
    });

    return initialization;
}

async function resetSnapshots() {
    await initializeSnapshots();
    if (!settings.store.lockEnabled) return;

    snapshots.clear();
    const channels = getGroupDms();
    for (const channel of channels) snapshotChannel(channel);
    await saveSnapshots();

    showToast(
        `Lock Group captured ${channels.length} group DM${channels.length === 1 ? "" : "s"}.`,
        Toasts.Type.SUCCESS
    );
}

async function runMembershipAction(
    action: "add" | "remove",
    channelId: string,
    userId: string
) {
    const key = `${action}:${channelId}:${userId}`;
    if (pendingActions.has(key)) return;
    pendingActions.add(key);

    try {
        const url = `/channels/${channelId}/recipients/${userId}`;
        if (action === "add") {
            await RestAPI.put({ url, body: {} });
        } else {
            await RestAPI.del({ url });
        }
    } catch (error) {
        logger.error(`Failed to ${action} recipient ${userId} in group DM ${channelId}`, error);
        showToast(
            `Lock Group could not ${action === "add" ? "re-add" : "kick"} a member. Check the console for details.`,
            Toasts.Type.FAILURE
        );
    } finally {
        pendingActions.delete(key);
    }
}

async function handleRecipientAdd({ channelId, user }: RecipientEvent) {
    if (!settings.store.lockEnabled || !user?.id) return;
    await initializeSnapshots();

    const channel = ChannelStore.getChannel(channelId) as GroupDmChannel | undefined;
    if (!isGroupDm(channel)) return;

    const lockedMembers = snapshots.get(channelId);
    if (!lockedMembers) {
        snapshotChannel(channel);
        await saveSnapshots();
        return;
    }

    if (!lockedMembers.has(user.id)) {
        await runMembershipAction("remove", channelId, user.id);
    }
}

async function handleRecipientRemove({ channelId, user }: RecipientEvent) {
    if (!settings.store.lockEnabled || !user?.id) return;
    await initializeSnapshots();

    const lockedMembers = snapshots.get(channelId);
    if (lockedMembers?.has(user.id)) {
        await runMembershipAction("add", channelId, user.id);
    }
}

export default definePlugin({
    name: "Lock Group",
    description: "Locks group DM membership by kicking new recipients and re-adding removed recipients.",
    authors: [Devs.NuzFlameV2, Devs.ItsDenji777],
    settings,

    start() {
        if (settings.store.lockEnabled) void initializeSnapshots();
    },

    stop() {
        pendingActions.clear();
    },

    flux: {
        CONNECTION_OPEN() {
            activeUserId = null;
            initialization = null;
            if (settings.store.lockEnabled) void initializeSnapshots();
        },

        async CHANNEL_CREATE({ channel }: { channel: GroupDmChannel; }) {
            if (!settings.store.lockEnabled || !isGroupDm(channel)) return;
            await initializeSnapshots();
            if (!snapshots.has(channel.id)) {
                snapshotChannel(channel);
                await saveSnapshots();
            }
        },

        async CHANNEL_DELETE({ channel }: { channel: GroupDmChannel; }) {
            if (!isGroupDm(channel)) return;
            await initializeSnapshots();
            if (snapshots.delete(channel.id)) await saveSnapshots();
        },

        CHANNEL_RECIPIENT_ADD: handleRecipientAdd,
        CHANNEL_RECIPIENT_REMOVE: handleRecipientRemove
    }
});

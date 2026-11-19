/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import typingIndicator from "@plugins/typingIndicator";
import { Devs } from "@utils/constants";
import { unwrapLazy } from "@utils/lazy";
import definePlugin, { OptionType } from "@utils/types";
import { filters, findStoreLazy, mapMangledModuleLazy } from "@webpack";
import { ReadStateStore, useStateFromStores } from "@webpack/common";

const UserGuildSettingsStore = findStoreLazy("UserGuildSettingsStore");
const JoinedThreadsStore = findStoreLazy("JoinedThreadsStore");
const NumberBadgeLazy = mapMangledModuleLazy('SQUARE:""}', {
    NumberBadge: filters.componentByCode("renderBadgeCount:")
}, true).NumberBadge;

const settings = definePluginSettings({
    showOnMutedChannels: {
        description: "Show unread count on muted channels",
        type: OptionType.BOOLEAN,
        default: false,
    },
    notificationCountLimit: {
        description: "Show +100 instead of the true unread count when it exceeds 100",
        type: OptionType.BOOLEAN,
        default: false,
    },
});

export default definePlugin({
    name: "UnreadCountBadge",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    authors: [Devs.Joona],
    description: "Shows unread message count badges on channels in the channel list",
    settings,

    patches: typingIndicator.patches.map(p => ({
        find: p.find,
        replacement: {
            match: p.replacement.match,
            replace: p.replacement.replace.replaceAll("TypingIndicator", "UnreadCountBadge")
        }
    })),

    UnreadCountBadge: (channelId: string, guildId: string) => {
        const unreadCount = useStateFromStores([ReadStateStore], () => ReadStateStore?.getUnreadCount(channelId) ?? 0, []);
        // Discord relocates this component between builds. When the filter misses, the lazy
        // resolves to nothing, and React reading a property off the unresolved proxy throws out
        // of the channel list render and takes the client with it. Resolve every lazy up front
        // and render nothing when one of them did not resolve.
        const NumberBadge = unwrapLazy(NumberBadgeLazy);
        if (!unreadCount || typeof NumberBadge !== "function") return null;

        const guildSettings = unwrapLazy(UserGuildSettingsStore);
        const joinedThreads = unwrapLazy(JoinedThreadsStore);
        if (!guildSettings || !joinedThreads) return null;

        if (!settings.store.showOnMutedChannels && (guildSettings.isChannelMuted(guildId, channelId) || joinedThreads.isMuted(channelId)))
            return null;

        return (
            <ErrorBoundary noop>
                <NumberBadge
                    color="var(--control-primary-background-default)"
                    className="vc-unreadcountbadge"
                    count={
                        unreadCount > 100 && settings.store.notificationCountLimit
                            ? "+100"
                            : unreadCount
                    }
                />
            </ErrorBoundary>
        );
    },
});

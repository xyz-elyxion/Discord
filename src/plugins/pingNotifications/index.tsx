/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MessageJSON } from "@limeyV1/discord-types";
import { Channel } from "@limeyV1/discord-types";
import {
    ChannelStore,
    NavigationRouter,
    PresenceStore,
    RelationshipStore,
    SelectedChannelStore,
    UserGuildSettingsStore,
    UserStore
} from "@webpack/common";

const settings = definePluginSettings({
    friends: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Notify when friends send messages in servers",
    },
    mentions: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify when someone @mentions you directly",
    },
    dms: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Notify for direct messages (DMs)",
    },
    showInActive: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Show notifications even for currently active channel",
    },
    ignoreMuted: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Skip notifications from muted servers, channels, or users",
    },
});

function formatContent(message: MessageJSON) {
    let content = message.content || "";
    message.mentions?.forEach(user => {
        content = content.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${user.username}`);
    });
    return content.slice(0, 200) + (content.length > 200 ? "..." : "");
}

function checkIfMuted(channel: Channel) {
    if (!settings.store.ignoreMuted) return false;
    if (!channel) return false;

    if ((channel as Channel & { isMuted?: () => boolean; }).isMuted?.()) return true;

    const isDM = [1, 3].includes(channel.type);
    if (isDM) {
        const recipientIds = channel.recipients || [];
        for (const userId of recipientIds) {
            if (RelationshipStore.isBlocked(userId)) return true;
        }
    }

    if (channel.guild_id) {
        if (UserGuildSettingsStore.isMuted(channel.guild_id)) return true;

        if (UserGuildSettingsStore.isMuted(channel.guild_id)) return true;
        if (UserGuildSettingsStore.isChannelMuted(channel.guild_id, channel.id)) return true;
        if (UserGuildSettingsStore.isCategoryMuted(channel.guild_id, channel.id)) return true;
    }

    return false;
}

function isUserBlocked(userId: string) {
    return settings.store.ignoreMuted && RelationshipStore.isBlocked?.(userId);
}

export default definePlugin({
    name: "PingNotifications",
    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own events and stores to read the content, authors and attachments of messages you can already see.",
            risk: "A buggy or abused plugin could collect, copy or act on private conversations."
        },
        {
            id: "sendNotifications",
            title: "Show notifications",
            description: "Shows a notification when friends ping/mention you in servers.",
            risk: "Frequent notifications could be used to distract or social-engineer you."
        }
    ],
    description: "Customizable notifications with improved mention formatting",
    tags: ["Chat", "Friends", "Notifications", "Servers"],
    authors: [Devs.smuki],
    settings,

    flux: {
        MESSAGE_CREATE({ message }: { message: MessageJSON; }) {
            try {
                if (!message?.channel_id || message.state === "SENDING") return;

                const channel = ChannelStore.getChannel(message.channel_id);
                const currentUser = UserStore.getCurrentUser();

                if (!channel || !currentUser) return;
                if (message.author?.id === currentUser.id) return;

                const isDM = [1, 3].includes(channel.type);

                if (checkIfMuted(channel)) return;
                if (isUserBlocked(message.author.id)) return;
                if (!settings.store.showInActive && channel.id === SelectedChannelStore.getChannelId()) return;
                if (PresenceStore.getStatus(currentUser.id) === "dnd") return;

                const author: { username: string; getAvatarURL?: (guildId?: string | null, size?: number, canAnimate?: boolean, format?: string) => string; } =
                    UserStore.getUser(message.author.id) || { username: "Unknown" };
                const channelName = channel.name || (isDM ? "DM" : "Group");
                const body = formatContent(message);

                let shouldNotify = false;

                if (settings.store.mentions && message.mentions?.some(u => u.id === currentUser.id)) {
                    shouldNotify = true;
                } else if (settings.store.friends && RelationshipStore.isFriend(message.author.id) && !isDM) {
                    shouldNotify = true;
                } else if (isDM && settings.store.dms) {
                    shouldNotify = true;
                }

                if (shouldNotify) {
                    showNotification({
                        title: `${author.username} in ${channelName}`,
                        body,
                        icon: author.getAvatarURL?.(undefined, 128),
                        onClick: () => NavigationRouter.transitionTo(
                            `/channels/${channel.guild_id || "@me"}/${channel.id}/${message.id}`
                        )
                    });
                }
            } catch (err) {
                console.error("[PingNotifications] Error:", err);
            }
        }
    }
});

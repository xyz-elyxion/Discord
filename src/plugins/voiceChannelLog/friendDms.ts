/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Friend DM voice-join notifications, ported from Equicord's VoiceJoinMessages
// plugin and merged into VoiceChannelLog.

import { humanFriendlyJoin } from "@utils/text";
import type { Message } from "@limeyV1/discord-types";
import { findByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, MessageActions, MessageStore, PermissionsBits, PermissionStore, RelationshipStore, SelectedChannelStore, UserStore } from "@webpack/common";

import settings from "./settings";

const createBotMessage = findByCodeLazy("username:\"Clyde\"");

interface VoiceState {
    guildId?: string;
    channelId?: string;
    oldChannelId?: string;
    user: Message["author"];
    userId: string;
}

function getMessageFlags() {
    let flags = 1 << 6;
    if (settings.store.friendDirectMessagesSilent) flags += 1 << 12;
    return flags;
}

function sendVoiceStatusMessage(channelId: string, content: string, userId: string): Message | null {
    if (!channelId) return null;
    const message: Message = createBotMessage({ channelId, content, embeds: [] });
    message.flags = getMessageFlags();
    message.author = UserStore.getUser(userId);
    // If we try to send a message into an unloaded channel, the client-sided messages get overwritten when the channel gets loaded
    // This might be messy but It Works:tm:
    const messagesLoaded: Promise<any> = MessageStore.hasPresent(channelId) ? new Promise<void>(r => r()) : MessageActions.fetchMessages({ channelId });
    messagesLoaded.then(() => {
        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId,
            message,
            optimistic: true,
            sendMessageOptions: {},
            isPushNotification: false
        });
    });
    return message;
}

function isFriendAllowlisted(friendId: string) {
    if (!RelationshipStore.isFriend(friendId)) return false;
    const ignoreList = settings.store.ignoredFriends.split(",").join(" ").split(" ").filter(i => i.length > 0);
    if (ignoreList.includes(friendId)) return false;
    const allowList = settings.store.allowedFriends.split(",").join(" ").split(" ").filter(i => i.length > 0);
    if (allowList.join(" ").length < 1) return true;
    return allowList.includes(friendId);
}

/**
 * Handle friend DM join notifications for a VOICE_STATE_UPDATES event.
 * Called from the plugin's main flux handler; returns early when disabled.
 */
export function handleFriendJoinMessages(voiceStates: VoiceState[]) {
    if (!settings.store.friendDirectMessages) return;

    const clientUserId = UserStore.getCurrentUser().id;
    for (const state of voiceStates) {
        const { userId, channelId } = state;

        if (settings.store.ignoreBlockedUsers && RelationshipStore.isBlocked(userId)) continue;
        // Ignore events within the same channel
        if (state.oldChannelId === channelId) continue;

        // Friend joined a voice channel
        if (!state.oldChannelId && channelId && userId !== clientUserId && isFriendAllowlisted(userId)) {
            const channel = ChannelStore.getChannel(channelId);
            if (!channel || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)) continue;

            const selfInChannel = SelectedChannelStore.getVoiceChannelId() === channelId;
            let memberListContent = "";
            if (settings.store.friendDirectMessagesShowMembers || settings.store.friendDirectMessagesShowMemberCount) {
                const users = Object.values<any>(voiceStates)
                    .filter(vs => vs.channelId === channelId)
                    .map(vs => UserStore.getUser(vs.userId))
                    .filter(user => user != null);

                const otherMembers = users.filter(s => s.id !== userId);
                const otherMembersCount = otherMembers.length;
                if (otherMembersCount <= 0) {
                    memberListContent += ", nobody else is in the voice channel";
                } else if (settings.store.friendDirectMessagesShowMemberCount) {
                    memberListContent += ` with ${otherMembersCount} other member${otherMembersCount === 1 ? "s" : ""}`;
                }
                if (settings.store.friendDirectMessagesShowMembers && otherMembersCount > 0) {
                    memberListContent += settings.store.friendDirectMessagesShowMemberCount ? ", " : " with ";
                    memberListContent += humanFriendlyJoin(otherMembers.map(s => `<@${s.id}>`));
                }
            }
            const dmChannelId = ChannelStore.getDMFromUserId(userId);
            if (dmChannelId && (selfInChannel ? settings.store.friendDirectMessagesSelf : true)) sendVoiceStatusMessage(dmChannelId, `Joined voice channel <#${channelId}>${memberListContent}`, userId);
        }
    }
}

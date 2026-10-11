/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

const settings = definePluginSettings({
    logJoinLeave: {
        type: OptionType.BOOLEAN,
        description: "Log when users join, leave, or move between voice channels.",
        default: true
    },
    logSoundboard: {
        type: OptionType.BOOLEAN,
        description: "Log when users play soundboard sounds.",
        default: true
    },
    logMuteDeafen: {
        type: OptionType.BOOLEAN,
        description: "Log when users are server muted or deafened.",
        default: true
    },
    logVideo: {
        type: OptionType.BOOLEAN,
        description: "Log when users turn their camera on or off.",
        default: true
    },
    logStream: {
        type: OptionType.BOOLEAN,
        description: "Log when users start or stop screensharing.",
        default: true
    },
    logActivity: {
        type: OptionType.BOOLEAN,
        description: "Log when users start embedded activities.",
        default: true
    },
    ignoreBlockedUsers: {
        type: OptionType.BOOLEAN,
        description: "Do not log blocked users.",
        default: false
    },
    friendDirectMessages: {
        type: OptionType.BOOLEAN,
        description: "Receive ephemeral messages in your friends' DMs when they join a voice channel.",
        default: true
    },
    friendDirectMessagesShowMembers: {
        type: OptionType.BOOLEAN,
        description: "Show a list of other members in the voice channel when receiving a DM notification.",
        default: true
    },
    friendDirectMessagesShowMemberCount: {
        type: OptionType.BOOLEAN,
        description: "Show the count of other members in the voice channel when receiving a DM notification.",
        default: false
    },
    friendDirectMessagesSelf: {
        type: OptionType.BOOLEAN,
        description: "Receive notifications in your friends' DMs even if you are in the same voice channel as them.",
        default: false
    },
    friendDirectMessagesSilent: {
        type: OptionType.BOOLEAN,
        description: "Join messages in your friends' DMs will be silent.",
        default: false
    },
    allowedFriends: {
        type: OptionType.STRING,
        description: "Comma or space separated list of friends' user IDs you want to receive join messages from (empty = all friends).",
        default: ""
    },
    ignoredFriends: {
        type: OptionType.STRING,
        description: "Comma or space separated list of friends' user IDs you do NOT want to receive join messages from.",
        default: ""
    },
    soundboardFileType: {
        type: OptionType.SELECT,
        description: "File format for downloading soundboard sounds.",
        options: [
            { label: ".ogg", value: ".ogg", default: true },
            { label: ".mp3", value: ".mp3" },
            { label: ".wav", value: ".wav" },
        ],
    },
    soundboardVolume: {
        type: OptionType.SLIDER,
        description: "Preview volume for soundboard sounds (0 to disable).",
        default: 0.5,
        markers: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]
    },
});

export default settings;

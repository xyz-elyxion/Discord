/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import type { MessageSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { copyWithToast, getCurrentChannel, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { sleep } from "@utils/misc";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { Channel } from "@limeyV1/discord-types";
import { ChannelStore, ComponentDispatch, PermissionsBits, PermissionStore, showToast, UserStore } from "@webpack/common";

import { splitMessage, type SplitMode } from "./splitMessage";

const MESSAGE_LIMIT = 2000;
const NITRO_MESSAGE_LIMIT = 4000;
const SLOWMODE_BUFFER_MS = 250;
const logger = new Logger("SplitLargeMessages");
const splitModes = new Set<SplitMode>(["characters", "spaces", "newlines"]);

const settings = definePluginSettings({
    sendDelay: {
        type: OptionType.SLIDER,
        description: "Minimum delay between each chunk in seconds.",
        markers: makeRange(0.5, 10, 0.5),
        default: 1,
        stickToMarkers: true,
    },
    splitMode: {
        type: OptionType.SELECT,
        description: "Prefer this boundary when splitting a message.",
        options: [
            { value: "newlines", label: "Newlines", default: true },
            { value: "spaces", label: "Spaces" },
            { value: "characters", label: "Strict character limit" },
        ],
    },
    splitInSlowmode: {
        type: OptionType.BOOLEAN,
        description: "Allow splitting in slowmode when its delay is within the configured maximum.",
        default: false,
    },
    slowmodeMax: {
        type: OptionType.SLIDER,
        description: "Maximum slowmode duration allowed when splitting messages.",
        markers: makeRange(1, 30, 1),
        default: 5,
        stickToMarkers: true,
    },
});

function getMessageLimit() {
    return UserStore.getCurrentUser()?.premiumType === 2 ? NITRO_MESSAGE_LIMIT : MESSAGE_LIMIT;
}

function getSplitMode(value: unknown): SplitMode {
    return typeof value === "string" && splitModes.has(value as SplitMode)
        ? value as SplitMode
        : "newlines";
}

function canBypassSlowmode(channel: Channel) {
    return PermissionStore.can(PermissionsBits.MANAGE_MESSAGES, channel)
        || PermissionStore.can(PermissionsBits.MANAGE_CHANNELS, channel);
}

function getSendDelay(channel: Channel) {
    const configuredDelay = settings.store.sendDelay * 1000;
    const slowmodeDelay = channel.rateLimitPerUser * 1000;

    return canBypassSlowmode(channel)
        ? configuredDelay
        : Math.max(configuredDelay, slowmodeDelay + SLOWMODE_BUFFER_MS);
}

function canSplitInChannel(channel: Channel | undefined) {
    if (!channel) return false;
    if (!channel.rateLimitPerUser || canBypassSlowmode(channel)) return true;

    return settings.store.splitInSlowmode
        && channel.rateLimitPerUser <= settings.store.slowmodeMax;
}

async function sendChunks(channelId: string, chunks: string[], delay: number) {
    let sent = 0;

    try {
        for (const [index, chunk] of chunks.entries()) {
            await sendMessage(channelId, { content: chunk }, true);
            sent++;

            if (index < chunks.length - 1) await sleep(delay);
        }
    } catch (error) {
        logger.error(`Failed after sending ${sent}/${chunks.length} message parts.`, error);
        return sent;
    }

    return sent;
}

function restoreUnsentContent(channelId: string, chunks: string[], sent: number) {
    const unsentContent = chunks.slice(sent).join("");
    if (!unsentContent) return;

    if (getCurrentChannel()?.id === channelId) {
        insertTextIntoChatInputBox(unsentContent);
    } else {
        copyWithToast(unsentContent, "Unsent message parts copied to clipboard.");
    }
}

const listener: MessageSendListener = async (channelId, message) => {
    const limit = getMessageLimit();
    if (message.content.length <= limit) return;

    const channel = ChannelStore.getChannel(channelId);
    if (!canSplitInChannel(channel)) {
        showToast("Cannot split this message because of the channel's slowmode.", "failure");
        return { cancel: true };
    }

    const chunks = splitMessage(message.content, limit, getSplitMode(settings.store.splitMode));
    ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");

    const sent = await sendChunks(channelId, chunks, getSendDelay(channel));
    if (sent !== chunks.length) {
        restoreUnsentContent(channelId, chunks, sent);
        showToast(`Only ${sent}/${chunks.length} message parts were sent.`, "failure");
    }

    return { cancel: true };
};

export default definePlugin({
    name: "SplitLargeMessages",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own events and stores to read the content, authors and attachments of messages you can already see.",
            risk: "A buggy or abused plugin could collect, copy or act on private conversations."
        },
        {
            id: "modifyMessages",
            title: "Alter outgoing messages",
            description: "Splits messages longer than Discord's limit into several sequential messages (with a configurable delay).",
            risk: "A long message becomes several sends; check for rate limits if spamming channels."
        }
    ],
    description: "Splits oversized messages into Discord-sized chunks before sending.",
    dependencies: ["MessageEventsAPI"],
    tags: ["Chat", "Utility"],
    authors: [Devs.Reycko, Devs.justjxke],
    settings,
    onBeforeMessageSend: listener,

    patches: [
        {
            find: 'type:"MESSAGE_LENGTH_UPSELL"', // bypass message length check
            replacement: {
                match: /if\(\i.length>\i/,
                replace: "if(false",
            },
        },
        {
            find: ".onHideAutocomplete?", // disable file conversion
            replacement: {
                match: /(?<=getData\(\i\.type\);)if\(\i.length>\i\)/,
                replace: "if(false)",
            },
        },
    ],
});

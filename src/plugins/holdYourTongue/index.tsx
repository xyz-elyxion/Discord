/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "HoldYourTongue" by Kaan
 * (https://github.com/zrodevkaan/BDPlugins) — re-implemented natively
 * for Limey V1.
 *
 * Hooks into Discord's message-content warning filters (the same system
 * that shows the "@everyone" confirmation) to stop you from sending
 * messages containing your flagged keywords.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { MessageActions, Modal, Button, openModal } from "@webpack/common";

// --- Reliable send interception -----------------------------------------------
// Discord's internal warning-filter list is not dependable across updates
// (the send path may snapshot the array or never iterate our entry), so we
// wrap MessageActions.sendMessage directly — a stable webpack export.

const settings = definePluginSettings({
    keywords: {
        description: "Keywords to watch for (one per line)",
        type: OptionType.STRING,
        multiline: true,
        default: "lipton green tea citrus"
    },
    body: {
        description: "Halt message. Use {words} where flagged words go",
        type: OptionType.STRING,
        multiline: true,
        default: "Woah there! You are about to send some keywords you don't want to send. e.g. {words}"
    }
});

function getKeywords(): string[] {
    return settings.store.keywords
        .split("\n")
        .map(k => k.trim())
        .filter(Boolean);
}

function check(content: string): { body: string } | false {
    const lower = content.toLowerCase();
    const found = getKeywords().filter(keyword => lower.includes(keyword.toLowerCase()));
    if (found.length === 0) return false;
    return {
        body: settings.store.body.replace("{words}", found.join(", "))
    };
}

// --- Reliable send interception -----------------------------------------------
// Discord's internal warning-filter array is not dependable across updates
// (the send path may snapshot the array or never iterate ours), so we also
// wrap MessageActions.sendMessage directly.

let originalSendMessage: any = null;

function makeConfirmModal(props: any, text: string, onConfirm: () => void) {
    return (
        <Modal
            {...props}
            transitionState={props.transitionState}
            size="md"
            title="Hold your tongue!"
        >
            <div style={{ marginBottom: 12 }}>{text}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button color={Button.Colors.RED} onClick={() => { props.onClose(); onConfirm(); }}>
                    Send anyway
                </Button>
                <Button color={Button.Colors.PRIMARY} onClick={props.onClose}>
                    Cancel
                </Button>
            </div>
        </Modal>
    );
}

function interceptSendMessage(channelId: string, data: any, ...rest: any[]) {
    const content = String(data?.content || "");
    const result = check(content);
    if (!result) return originalSendMessage!(channelId, data, ...rest);

    openModal(props => makeConfirmModal(
        props,
        result.body,
        () => originalSendMessage!(channelId, data, ...rest)
    ));
}
export default definePlugin({
    name: "HoldYourTongue",
    description: "Stop yourself from saying things in chat! Blocks sending messages that contain your flagged keywords",
    authors: [Devs.Limey],
    settings,

    patches: [],

    start() {
        // Discord's internal warning-filter array is unreliable across updates
        // (the send path may snapshot the array or never iterate ours), so we
        // wrap MessageActions.sendMessage directly for a guaranteed block.
        if (!originalSendMessage && typeof MessageActions?.sendMessage === "function") {
            originalSendMessage = MessageActions.sendMessage;
            MessageActions.sendMessage = interceptSendMessage as any;
        } else {
            console.warn("[HoldYourTongue] MessageActions.sendMessage not found; plugin inactive.");
        }
    },

    stop() {
        if (originalSendMessage) {
            MessageActions.sendMessage = originalSendMessage;
            originalSendMessage = null;
        }
    },
});

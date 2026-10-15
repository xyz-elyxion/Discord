/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, showToast } from "@webpack/common";

import { scamMatch } from "./patterns";

const settings = definePluginSettings({
    toastOnDetect: {
        type: OptionType.BOOLEAN,
        description: "Send a toast when a message you can see matches a scam rule.",
        default: true,
        restartNeeded: false,
    },
    inlineBadge: {
        type: OptionType.BOOLEAN,
        description: "Decorate matching messages with a 🚫 Scam badge (tooltip lists the rules caught).",
        default: true,
        restartNeeded: false,
    },
});

function isSystemMessage(message: any): boolean {
    // System messages (joins, pins, calls, auto-mod notices, …) and author
    // system states can't be scam bait.
    if (typeof message?.type === "number" && message.type !== 0) return true;
    if (message?.author?.system) return true;
    // Bots and webhooks are still checked — tokens can act through either.
    return false;
}

function detect(message: any): string[] | null {
    const content = message?.content;
    if (typeof content !== "string" || !content) return null;

    const { scam, rules } = scamMatch(content);
    if (!scam) return null;
    return rules;
}

const onMessageCreate = (e: any) => {
    const message = e?.message ?? e;
    if (!message || isSystemMessage(message)) return;

    const rules = detect(message);
    if (!rules) return;

    const who = message.author?.username
        ?? message.author?.id
        ?? "someone";

    console.warn(
        `[ScamBotDetector] flagged message from ${who} (${rules.join(", ")}) — channel ${message.channel_id ?? "unknown"}`,
    );

    if (settings.store.toastOnDetect) {
        showToast(`ScamBotDetector: ${who} — ${rules.join(", ")}`, "failure");
    }
};

function ScamBadge({ message }: { message?: any; }) {
    if (!settings.store.inlineBadge) return null;

    const rules = detect(message);
    if (!rules) return null;

    return (
        <span
            title={`ScamBotDetector: ${rules.join(", ")}`}
            style={{
                fontSize: "11px",
                marginLeft: "3px",
                cursor: "default",
                userSelect: "none",
                verticalAlign: "middle",
                display: "inline-flex",
                alignItems: "center",
                color: "#ed4245",
                fontWeight: 700,
            }}
        >
            🚫 Scam
        </span>
    );
}

export default definePlugin({
    name: "ScamBotDetector",
    description: "Flags the known scam-bot patterns from AutoMod (cam bait, sexual invite links, fake steam gift markdown, mimic domains, attachment-image walls) in messages you can see — 🚫 Scam decoration plus an optional toast. Plain steamcommunity.com links are allowed.",
    tags: ["Utility", "Media"],
    searchTerms: ["scam", "detect", "automod", "steam gift", "phishing", "nsfw invite"],
    authors: [Devs.Limey],

    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own message events to check new messages against the scam patterns.",
            risk: "A buggy or abused plugin could act on the content of private conversation. This plugin only flags locally and never sends anything anywhere."
        }
    ],

    settings,
    dependencies: ["MessageDecorationsAPI"],

    start() {
        addMessageDecoration("ScamBotDetector", props => <ScamBadge message={props?.message} />);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },

    stop() {
        removeMessageDecoration("ScamBotDetector");
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    },
});

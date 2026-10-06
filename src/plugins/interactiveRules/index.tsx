/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * InteractiveRules — when you open the Limey V1 rules channel, instead of a
 * plain message list you get a sleek interactive rules browser: searchable
 * rule cards, expand/collapse, category filters, and progress tracking of
 * which rules you've read. Everyone else still sees the normal (bot-posted)
 * rules message, so the channel works for everyone.
 */

import "./style.css";

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { createRoot, SelectedChannelStore } from "@webpack/common";

import { RulesBrowser } from "./RulesBrowser";
import { RulesChangelog } from "./changelog";
import { RULES_CHANNEL_ID } from "./rules";

const OVERLAY_ID = "limey-interactive-rules-root";
const CHAT_SELECTOR = `[class*="chatContent_"], [class*="chat_"]`;

let host: HTMLDivElement | null = null;
let observer: MutationObserver | null = null;

// Set once we've confirmed the rules channel exists on this client's server
let hasRulesChannel = false;

function checkRulesChannel(channelId?: string) {
    const id = channelId ?? SelectedChannelStore.getChannelId();
    hasRulesChannel = hasRulesChannel || id === RULES_CHANNEL_ID;
    return hasRulesChannel;
}

function unmount() {
    if (host) {
        createRoot(host).unmount();
        host.remove();
        host = null;
    }
    observer?.disconnect();
    observer = null;
}

function mount(channelId: string) {
    if (channelId !== RULES_CHANNEL_ID) {
        unmount();
        return;
    }

    // wait for the chat area to appear, then cover it with the rules browser
    observer?.disconnect();
    observer = new MutationObserver(() => {
        const chat = document.querySelector<HTMLElement>(CHAT_SELECTOR);
        if (!chat) return;
        observer?.disconnect();
        observer = null;

        if (SelectedChannelStore.getChannelId() !== RULES_CHANNEL_ID) return;

        host ??= (() => {
            const el = document.createElement("div");
            el.id = OVERLAY_ID;
            el.className = "limey-interactive-rules-host";
            chat.appendChild(el);
            return el;
        })();

        createRoot(host).render(<RulesBrowser variant="channel" />);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function onChannelSelect({ channelId }: { channelId: string; }) {
    checkRulesChannel(channelId);
    mount(channelId);
}

export default definePlugin({
    name: "InteractiveRules",
    permissions: [{
        id: "uiPatches",
        title: "Replace the rules channel message list with an interactive browser",
        description: "Overrides the chat area contents while you're viewing the Limey V1 rules channel.",
        risk: "Only affects the appearance of one channel on your client. Disabling the plugin restores the normal view."
    }],
    description: "Turns the Limey V1 rules channel into an interactive, searchable rules browser with reading progress.",
    tags: ["Appearance", "Utility", "Servers"],
    authors: [Devs.Limey],

    settingsAboutComponent: RulesChangelog,

    toolboxActions() {
        // The rules channel doesn't exist on this server — no action
        if (!checkRulesChannel()) return null;

        return {
            "Open Rules Browser": () => mount(RULES_CHANNEL_ID),
        };
    },

    flux: {
        CHANNEL_SELECT: onChannelSelect,
    },

    start() {
        checkRulesChannel();
        mount(SelectedChannelStore.getChannelId());
    },

    stop: unmount,
});

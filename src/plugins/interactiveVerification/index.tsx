/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * InteractiveVerification — replaces the verification channel message list
 * with a native in-client verification card. Verifying happens entirely in
 * the client: the plugin opens Discord's OAuth authorize modal (identify
 * scope), the callback confirms your user id to the bot, and the verified
 * role is granted instantly. No website needed.
 */

import "./style.css";

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { createRoot, showToast, Toasts } from "@webpack/common";

import { VerifyCard } from "./VerifyCard";
import { VERIFICATION_CHANNEL_ID } from "./shared";

const OVERLAY_ID = "limey-interactive-verify-root";
const CHAT_SELECTOR = `[class*="chatContent_"], [class*="chat_"]`;

let host: HTMLDivElement | null = null;
let observer: MutationObserver | null = null;

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
    if (channelId !== VERIFICATION_CHANNEL_ID) {
        unmount();
        return;
    }

    observer?.disconnect();
    observer = new MutationObserver(() => {
        const chat = document.querySelector<HTMLElement>(CHAT_SELECTOR);
        if (!chat) return;
        observer?.disconnect();
        observer = null;

        host ??= (() => {
            const el = document.createElement("div");
            el.id = OVERLAY_ID;
            el.className = "limey-interactive-verify-host";
            chat.appendChild(el);
            return el;
        })();

        createRoot(host).render(<VerifyCard />);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

export default definePlugin({
    name: "InteractiveVerification",
    permissions: [{
        id: "uiPatches",
        title: "Replace the verification channel with an interactive card",
        description: "Overrides the chat area while viewing the verification channel, and sends your Discord user id to Limey's verification API when you verify.",
        risk: "Only affects one channel's appearance. Verification sends nothing but your Discord user id (which the bot can already see)."
    }],
    description: "Verify into the Limey V1 server instantly, right from your client — no website needed.",
    tags: ["Utility", "Servers"],
    authors: [Devs.Limey],

    toolboxActions: {
        "Open Verification": () => mount(VERIFICATION_CHANNEL_ID),
    },

    flux: {
        CHANNEL_SELECT({ channelId }: { channelId: string; }) {
            mount(channelId);
        },
    },

    start() {
        // no-op mount: only triggers when the channel is selected
    },

    stop: unmount,
});

export function toast(msg: string, ok: boolean) {
    showToast(msg, ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
}

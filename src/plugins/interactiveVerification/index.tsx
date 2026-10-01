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
import { createRoot, GuildStore, showToast, Toasts } from "@webpack/common";

import { VerifyCard } from "./VerifyCard";
import { guildVerifyConfigs, VERIFICATION_CHANNEL_ID } from "./shared";

const OVERLAY_ID = "limey-interactive-verify-root";
const CHAT_SELECTOR = `[class*="chatContent_"], [class*="chat_"]`;
const SITE_ORIGIN = "https://limey-discord.onrender.com";

let host: HTMLDivElement | null = null;
let observer: MutationObserver | null = null;

// guildId of the channel currently mounted (or null for the fallback channel)
let mountedGuildId: string | null = null;

// Channels of guilds that have verification configured (channelId -> guildId),
// lazily refreshed from the site so any server can use the plugin.
const verifyChannels = new Map<string, string>([[VERIFICATION_CHANNEL_ID, "1550709562267672607"]]);

async function refreshVerifyChannels() {
    // Ask the site which guilds the current user shares with the bot have
    // verification configured. The endpoint returns configs for guilds the
    // bot is in; we filter by the guilds the client is actually in.
    try {
        const ids = Object.keys(GuildStore.getGuilds() ?? {})
            .filter(id => /^\d{17,20}$/.test(id))
            .slice(0, 100)
            .join(",");
        if (!ids) return;
        const res = await fetch(`${SITE_ORIGIN}/v1/verify/guilds?ids=${ids}`, {
            signal: AbortSignal.timeout(10_000)
        });
        if (!res.ok) return;
        const data = await res.json();
        for (const cfg of data.guilds ?? []) {
            if (!cfg?.channelId || !cfg?.guildId) continue;
            verifyChannels.set(cfg.channelId, cfg.guildId);
            guildVerifyConfigs.set(cfg.guildId, {
                channelId: cfg.channelId,
                rulesChannelId: cfg.rulesChannelId ?? null,
                roleId: cfg.roleId ?? null,
            });
        }
    } catch { /* offline or not configured — fallback channels still work */ }
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
    const guildId = verifyChannels.get(channelId);
    if (!guildId) {
        unmount();
        // opportunistically refresh configs so newly-set-up servers appear
        void refreshVerifyChannels();
        return;
    }
    mountedGuildId = guildId;

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

        createRoot(host).render(<VerifyCard guildId={mountedGuildId} />);
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
        void refreshVerifyChannels();
    },

    stop: unmount,
});

export function toast(msg: string, ok: boolean) {
    showToast(msg, ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
}

/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, findOption, sendBotMessage } from "@api/Commands";
import { Command } from "@limeyV1/discord-types";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { FluxDispatcher, Toasts, UserStore, showToast } from "@webpack/common";

const logger = new Logger("LimeRewards");

const BASE = "https://limey-discord.onrender.com/v1/limes";
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;

// --- tiny client for the economy backend ---

async function api(path: string, init?: RequestInit) {
    const res = await fetch(BASE + path, {
        ...init,
        headers: {
            "Content-Type": "application/json",
            "x-limey-user-id": UserStore.getCurrentUser()?.id ?? "",
            ...(init?.headers as Record<string, string> | undefined)
        }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error ?? `Request failed (${res.status})`), { status: res.status, body });
    return body;
}

interface Wallet {
    balance: number;
    streak: number;
    tier: string | null;
    multiplier: number;
    nextDailyAt: number;
}

let cachedWallet: Wallet | null = null;

async function getWallet(): Promise<Wallet> {
    if (!cachedWallet) cachedWallet = await api("/wallet") as Wallet;
    return cachedWallet;
}

function invalidateWallet() {
    cachedWallet = null;
}

function notifyEarned(amount: number, balance: number, label: string) {
    if (amount <= 0) return;
    showToast(`+${amount} 🍋 ${label} — ${balance} Limes`, Toasts.Type.SUCCESS);
}

// --- earning: daily claim ---

async function claimDaily() {
    const wallet = await getWallet();
    const remaining = wallet.nextDailyAt - Date.now();
    if (remaining > 0) {
        const hours = Math.ceil(remaining / (60 * 60 * 1000));
        showToast(`Daily Limes ready in ~${hours}h`, Toasts.Type.MESSAGE);
        return;
    }

    const res = await api("/earn/daily", { method: "POST" }) as { amount: number; balance: number; streak: number; streakBonus: number; multiplier: number };
    invalidateWallet();

    const parts = ["Daily claim"];
    if (res.streakBonus > 0) parts.push(`${res.streak}-day streak +${res.streakBonus}`);
    if (res.multiplier > 1) parts.push(`Orchard x${res.multiplier}`);
    notifyEarned(res.amount, res.balance, parts.join(" · "));
}

// --- earning: messages (batched, 1 Lime per 25 messages, server-capped) ---

let messageBuffer = 0;
let messageFlushTimer: any = null;

function trackMessage() {
    messageBuffer++;
    if (messageFlushTimer) return;
    // flush at most every 2 minutes of activity
    messageFlushTimer = setTimeout(flushMessages, 120_000);
}

async function flushMessages() {
    messageFlushTimer = null;
    const count = messageBuffer;
    messageBuffer = 0;
    if (!count) return;

    try {
        const res = await api("/earn/message", { method: "POST", body: JSON.stringify({ count }) }) as { awarded: number; balance: number };
        if (res.awarded > 0) {
            invalidateWallet();
            notifyEarned(res.awarded, res.balance, "chat activity");
        }
    } catch (error) {
        logger.error("Failed to track messages", error);
    }
}

// --- earning: voice time (5 Limes per 15 min connected) ---

let voiceChannelId: string | null = null;
let voiceJoinedAt = 0;
let voiceReporter: any = null;

function startVoiceTracking() {
    stopVoiceTracking();
    voiceReporter = setInterval(async () => {
        if (!voiceChannelId || !voiceJoinedAt) return;
        const minutes = Math.floor((Date.now() - voiceJoinedAt) / 60_000);
        const reportable = Math.floor(minutes / 15) * 15;
        if (reportable <= 0) return;

        voiceJoinedAt += reportable * 60_000; // only report the elapsed blocks once
        try {
            const res = await api("/earn/voice", { method: "POST", body: JSON.stringify({ minutes: reportable }) }) as { awarded: number; balance: number };
            if (res.awarded > 0) {
                invalidateWallet();
                notifyEarned(res.awarded, res.balance, "voice time");
            }
        } catch (error) {
            logger.error("Failed to track voice time", error);
        }
    }, 5 * 60_000); // check every 5 minutes
}

function stopVoiceTracking() {
    if (voiceReporter) {
        clearInterval(voiceReporter);
        voiceReporter = null;
    }
}

function onVoiceStateUpdates(event: any) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;

    for (const state of event.voiceStates ?? []) {
        if (state.userId !== me) continue;
        if (state.channelId && !voiceChannelId) {
            voiceChannelId = state.channelId;
            voiceJoinedAt = Date.now();
        } else if (!state.channelId && voiceChannelId) {
            voiceChannelId = null;
            voiceJoinedAt = 0;
        }
    }
}

// --- /limes command ---

function makeLimesCommand(): Command {
    return {
        name: "limes",
        description: "View your Lime balance and claim daily Limes",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            {
                name: "action",
                description: "What to do",
                type: 3, // STRING
                required: true,
                choices: [
                    { name: "daily", label: "Claim daily Limes", value: "daily" },
                    { name: "balance", label: "Show balance and tier", value: "balance" },
                    { name: "store", label: "How to spend Limes", value: "store" }
                ]
            }
        ],
        async execute(args, ctx) {
            const action = findOption<string>(args, "action", "balance");

            try {
                if (action === "daily") {
                    await claimDaily();
                    return;
                }

                const wallet = await getWallet();
                if (action === "store") {
                    return sendBotMessage(ctx.channel.id, {
                        content: `You have **${wallet.balance}** 🍋\nSpend them at https://limey-discord.onrender.com/limes — tiers: **Seedling** (200/mo), **Grove** (500/mo), **Orchard** (1200/mo). Each tier has a free trial!`
                    });
                }

                const tier = wallet.tier ? ` — **${wallet.tier.charAt(0).toUpperCase() + wallet.tier.slice(1)}** tier${wallet.multiplier > 1 ? ` (x${wallet.multiplier} daily)` : ""}` : "";
                const nextDaily = wallet.nextDailyAt > Date.now()
                    ? `Daily claim ready in ~${Math.ceil((wallet.nextDailyAt - Date.now()) / (60 * 60 * 1000))}h`
                    : "Daily claim ready — run `/limes daily`!";
                return sendBotMessage(ctx.channel.id, {
                    content: `🍋 **${wallet.balance} Limes** (streak: ${wallet.streak} days)${tier}\n${nextDaily}`
                });
            } catch (error) {
                logger.error("Limes command failed", error);
                return sendBotMessage(ctx.channel.id, { content: `🍋 Limes error: ${(error as Error).message}` });
            }
        }
    };
}

export default definePlugin({
    name: "LimeRewards",
    description: "Earn Limes (🍋) for using Discord and spend them on perk tiers at limey-discord.onrender.com/limes. This plugin powers the Lime economy and is always on.",
    tags: ["Utility", "Fun"],
    authors: [Devs.Limey],
    required: true,
    commands: [makeLimesCommand()],

    flux: {
        MESSAGE_CREATE: trackMessage,
        VOICE_STATE_UPDATES: onVoiceStateUpdates
    },

    start() {
        // warm the wallet shortly after startup
        setTimeout(() => {
            getWallet().then(wallet => logger.info(`Wallet synced: ${wallet.balance} Limes${wallet.tier ? ` (${wallet.tier})` : ""}`))
                .catch(error => logger.error("Failed to sync wallet", error));
        }, 15_000);

        startVoiceTracking();

        // periodic re-sync so tier expiry is reflected
        const resync = setInterval(() => invalidateWallet(), 5 * 60_000);
        this.stop = () => {
            clearInterval(resync);
            stopVoiceTracking();
            flushMessages();
        };
    }
});

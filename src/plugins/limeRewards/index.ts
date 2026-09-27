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
import { findByPropsLazy } from "@webpack";
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
// --- earning: streaming (10 Limes per 15 min live) ---
// --- earning: playing a game (3 Limes per 15 min in-game) ---
// All three share the same 15-minute block reporter pattern.

function makeBlockReporter(source: "voice" | "stream" | "game", intervalMs = 5 * 60_000) {
    let activeAt = 0;
    let timer: any = null;

    async function report(source: "voice" | "stream" | "game", minutes: number) {
        try {
            const res = await api(`/earn/${source}`, { method: "POST", body: JSON.stringify({ minutes }) }) as { awarded: number; balance: number };
            if (res.awarded > 0) {
                invalidateWallet();
                const label = source === "voice" ? "voice time" : source === "stream" ? "streaming" : "playing a game";
                notifyEarned(res.awarded, res.balance, label);
            }
        } catch (error) {
            logger.error(`Failed to track ${source}`, error);
        }
    }

    return {
        setActive(active: boolean) {
            if (active && !activeAt) activeAt = Date.now();
            if (!active && activeAt) {
                const minutes = Math.floor((Date.now() - activeAt) / 60_000);
                const reportable = Math.floor(minutes / 15) * 15;
                activeAt = 0;
                if (reportable > 0) report(source, reportable);
            }
        },
        start() {
            stop();
            timer = setInterval(() => {
                if (!activeAt) return;
                const minutes = Math.floor((Date.now() - activeAt) / 60_000);
                const reportable = Math.floor(minutes / 15) * 15;
                if (reportable > 0) {
                    activeAt += reportable * 60_000; // only report each block once
                    report(source, reportable);
                }
            }, intervalMs);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }
    };
}

const voiceReporter = makeBlockReporter("voice");
const streamReporter = makeBlockReporter("stream");
const gameReporter = makeBlockReporter("game");

function onVoiceStateUpdates(event: any) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;

    for (const state of event.voiceStates ?? []) {
        if (state.userId !== me) continue;
        const connected = Boolean(state.channelId);
        voiceReporter.setActive(connected);
        // streaming = self_stream flag while connected
        streamReporter.setActive(connected && Boolean(state.selfStream));
    }
}

// games: the SelfPresenceStore exposes what activity the client has set
const SelfPresenceStore = findByPropsLazy("getSelfPresence");

function trackGameActivity() {
    try {
        const presence = SelfPresenceStore.getSelfPresence?.(UserStore.getCurrentUser()?.id);
        const activity = presence?.activities?.find((a: any) => a.type === 0); // 0 = PLAYING
        gameReporter.setActive(Boolean(activity));
    } catch {
        // presence store shape may differ; game tracking is best-effort
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
    description: "Earn Limes (🍋) for using Discord — daily claims, chatting, voice, streaming and gaming — and spend them on perk tiers at limey-discord.onrender.com/limes. This plugin powers the Lime economy and is always on.",
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

        voiceReporter.start();
        streamReporter.start();
        gameReporter.start();
        // poll game presence periodically (no flux event for self activity changes)
        const gamePoll = setInterval(trackGameActivity, 60_000);

        // periodic re-sync so tier expiry is reflected
        const resync = setInterval(() => invalidateWallet(), 5 * 60_000);
        this.stop = () => {
            clearInterval(resync);
            clearInterval(gamePoll);
            voiceReporter.stop();
            streamReporter.stop();
            gameReporter.stop();
            flushMessages();
        };
    }
});

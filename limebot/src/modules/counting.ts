/*
 * Counting: each configured channel has a running count. Users take turns
 * posting the next number; wrong numbers, repeats and bots break the chain
 * and the count resets. The best count is remembered per guild.
 */

import { Message } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface CountingConfig {
    guildId: string;
    channelId: string;
    current: number;
    lastUserId: string | null;
    best: number;
    recordMessageId: string | null;
    enabled: boolean;
}

const configs = new Map<string, CountingConfig>(); // guildId -> cfg
const channelIndex = new Map<string, string>(); // channelId -> guildId

export function getCountingConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export function getCountingByChannel(channelId: string) {
    const guildId = channelIndex.get(channelId);
    return guildId ? configs.get(guildId) ?? null : null;
}

export async function setCountingConfig(cfg: CountingConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    channelIndex.set(cfg.channelId, cfg.guildId);
    await db.insertInto("countingConfigs")
        .values({
            guildId: cfg.guildId,
            channelId: cfg.channelId,
            current: cfg.current,
            lastUserId: cfg.lastUserId,
            best: cfg.best,
            recordMessageId: cfg.recordMessageId,
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            channelId: cfg.channelId,
            current: cfg.current,
            lastUserId: cfg.lastUserId,
            best: cfg.best,
            recordMessageId: cfg.recordMessageId,
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableCountingConfig(guildId: string) {
    const prev = configs.get(guildId);
    if (prev) {
        channelIndex.delete(prev.channelId);
        configs.delete(guildId);
    }
    await db.deleteFrom("countingConfigs").where("guildId", "=", guildId).execute();
}

async function persistProgress(cfg: CountingConfig) {
    await db.updateTable("countingConfigs")
        .set({
            current: cfg.current,
            lastUserId: cfg.lastUserId,
            best: cfg.best,
            recordMessageId: cfg.recordMessageId,
        })
        .where("guildId", "=", cfg.guildId)
        .execute();
}

async function loadCountingConfigs() {
    const rows = await db.selectFrom("countingConfigs").selectAll().execute();
    for (const r of rows) {
        if (!r.enabled) continue;
        const cfg: CountingConfig = {
            guildId: r.guildId,
            channelId: r.channelId,
            current: r.current,
            lastUserId: r.lastUserId,
            best: r.best,
            recordMessageId: r.recordMessageId,
            enabled: true,
        };
        configs.set(cfg.guildId, cfg);
        channelIndex.set(cfg.channelId, cfg.guildId);
    }
    console.log(`[counting] loaded ${configs.size} channel config(s)`);
}

export function initCounting() {
    void loadCountingConfigs();

    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot || msg.webhookID) return;
            const cfg = getCountingByChannel(msg.channelID);
            if (!cfg || !cfg.enabled || !msg.guildID) return;

            const parsed = Number.parseInt(msg.content.trim(), 10);
            if (!Number.isFinite(parsed) || String(parsed) !== msg.content.trim()) {
                await Vaius.rest.channels.deleteMessage(msg.channelID, msg.id, "Counting: numbers only").catch(() => null);
                return;
            }

            const expected = cfg.current + 1;
            const sameUser = cfg.lastUserId === msg.author.id && cfg.current !== 0;

            if (parsed !== expected || sameUser) {
                // broken chain — react, announce, reset
                await Vaius.rest.channels.createReaction(msg.channelID, msg.id, "❌").catch(() => null);
                const reason = sameUser ? `<@${msg.author.id}> counted twice in a row!` : `<@${msg.author.id}> broke the chain — next number was **${expected}**.`;
                await Vaius.rest.channels.createMessage(msg.channelID, {
                    content: `${reason}\n## Count reset to 0\n-# Record: **${cfg.best}**`,
                    allowedMentions: { everyone: false, users: true },
                }).catch(() => null);
                cfg.current = 0;
                cfg.lastUserId = null;
                await persistProgress(cfg);
                return;
            }

            // correct count
            cfg.current = parsed;
            cfg.lastUserId = msg.author.id;
            if (parsed > cfg.best) {
                cfg.best = parsed;
                cfg.recordMessageId = msg.id;
            }
            await Vaius.rest.channels.createReaction(msg.channelID, msg.id, "✅").catch(() => null);
            if (parsed % 100 === 0) {
                await Vaius.rest.channels.createMessage(msg.channelID, {
                    content: `🎉 **${parsed}!** <@${msg.author.id}> — new milestone! Record: **${cfg.best}**`,
                    allowedMentions: { everyone: false, users: true },
                }).catch(() => null);
            }
            await persistProgress(cfg);
        } catch (e) {
            console.error("[counting] error:", e);
        }
    });
}

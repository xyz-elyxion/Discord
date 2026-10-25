/*
 * Suggestions: a configured channel where every non-bot message gets
 * 👍 / 👎 reactions added automatically so members can vote on ideas.
 * Managed from the dashboard.
 */

import { Message } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface SuggestionConfig {
    guildId: string;
    channelId: string;
    enabled: boolean;
}

const configs = new Map<string, SuggestionConfig>(); // guildId -> cfg

export function getSuggestionConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setSuggestionConfig(cfg: SuggestionConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("suggestionConfigs")
        .values({
            guildId: cfg.guildId,
            channelId: cfg.channelId,
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            channelId: cfg.channelId,
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableSuggestionConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("suggestionConfigs").where("guildId", "=", guildId).execute();
}

export function initSuggestions() {
    void db.selectFrom("suggestionConfigs").selectAll().execute().then(rows => {
        for (const r of rows) {
            if (!r.enabled) continue;
            configs.set(r.guildId, {
                guildId: r.guildId,
                channelId: r.channelId,
                enabled: true,
            });
        }
        console.log(`[suggestions] loaded ${configs.size} guild config(s)`);
    });

    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (!msg.guildID || msg.author.bot) return;
            const cfg = configs.get(msg.guildID);
            if (!cfg || !cfg.enabled || msg.channelID !== cfg.channelId) return;

            // Thread/webhook noise — ignore anything that isn't a plain member message
            if (msg.webhookID) return;

            await Vaius.rest.channels.createReaction(msg.channelID, msg.id, "👍");
            await Vaius.rest.channels.createReaction(msg.channelID, msg.id, "👎");
        } catch (e) {
            console.error("[suggestions] error:", e);
        }
    });
}

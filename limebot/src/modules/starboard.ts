/*
 * Starboard: highly-reacted messages from anywhere in the guild get mirrored
 * into a configured starboard channel as embeds with a live star count.
 * Managed from the dashboard.
 */

import { MessageReactionAdd, MessageReactionRemove } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface StarboardConfig {
    guildId: string;
    channelId: string;
    threshold: number;
    emoji: string; // unicode emoji (default ⭐)
    enabled: boolean;
}

export interface StarboardEntry {
    guildId: string;
    originalId: string;
    starboardMessageId: string;
}

const configs = new Map<string, StarboardConfig>(); // guildId -> cfg
const starred = new Map<string, string>(); // `${guildId}:${originalId}` -> starboard message id

export function getStarboardConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setStarboardConfig(cfg: StarboardConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("starboardConfigs")
        .values({
            guildId: cfg.guildId,
            channelId: cfg.channelId,
            threshold: cfg.threshold,
            emoji: cfg.emoji,
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            channelId: cfg.channelId,
            threshold: cfg.threshold,
            emoji: cfg.emoji,
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableStarboardConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("starboardConfigs").where("guildId", "=", guildId).execute();
}

function normalizeEmoji(emoji: { id: string | null; name: string | null }) {
    return emoji.id ?? emoji.name ?? "";
}

async function renderStar(cfg: StarboardConfig, channelId: string, messageId: string, count: number) {
    const channel = Vaius.getChannel(channelId);
    if (!channel) return;

    const orig = await Vaius.rest.channels.getMessage(channelId, messageId).catch(() => null);
    if (!orig) return;

    const embed = {
        author: {
            name: (orig.author.globalName ?? orig.author.username) + "  •  #" + (orig.channel?.name ?? channel?.name ?? "?"),
            iconURL: orig.author.avatar
                ? orig.author.avatarURL("png", 64)
                : undefined,
        },
        description: orig.content || "*no text content*",
        color: 0xf1c40f,
        fields: [{ name: cfg.emoji, value: `**${count}**`, inline: true }],
        image: orig.attachments.find(a => a.content_type?.startsWith("image/"))?.proxyURL,
        footer: { text: `ID: ${orig.id}` },
        timestamp: orig.timestamp,
    };

    const key = `${cfg.guildId}:${orig.id}`;
    const existingId = starred.get(key);
    if (existingId) {
        await Vaius.rest.channels.editMessage(cfg.channelId, existingId, { embeds: [embed] })
            .catch(e => console.error("[starboard] failed to update star:", (e as Error).message));
        return;
    }

    const posted = await Vaius.rest.channels.createMessage(cfg.channelId, {
        content: `${cfg.emoji} **${count}** — <#${orig.channelID}>`,
        embeds: [embed],
        allowedMentions: { everyone: false },
    }).catch(e => {
        console.error("[starboard] failed to post star:", (e as Error).message);
        return null;
    });
    if (posted) {
        starred.set(key, posted.id);
        await db.insertInto("starboardEntries")
            .values({ guildId: cfg.guildId, originalId: orig.id, starboardMessageId: posted.id })
            .onConflict(oc => oc.column("originalId").doUpdateSet({ starboardMessageId: posted.id }))
            .execute();
    }
}

export function initStarboard() {
    void Promise.all([
        db.selectFrom("starboardConfigs").selectAll().execute(),
        db.selectFrom("starboardEntries").selectAll().execute(),
    ]).then(([cfgRows, entryRows]) => {
        for (const r of cfgRows) {
            if (!r.enabled) continue;
            configs.set(r.guildId, {
                guildId: r.guildId,
                channelId: r.channelId,
                threshold: r.threshold,
                emoji: r.emoji,
                enabled: true,
            });
        }
        for (const r of entryRows) {
            starred.set(`${r.guildId}:${r.originalId}`, r.starboardMessageId);
        }
        console.log(`[starboard] loaded ${configs.size} guild config(s), ${starred.size} starred message(s)`);
    });

    const handle = async (
        msg: Parameters<MessageReactionAdd>[0],
        _userId: string,
        opts: { emoji: { id: string | null; name: string | null } },
        removed: boolean,
    ) => {
        try {
            const guild = msg.guild;
            if (!guild) return;
            const cfg = configs.get(guild.id);
            if (!cfg || !cfg.enabled) return;
            if (normalizeEmoji(opts.emoji) !== cfg.emoji) return;
            if (msg.channelID === cfg.channelId) return; // don't star the starboard itself

            // fetch fresh reaction count from the cache-less message
            const full = await Vaius.rest.channels.getMessage(msg.channelID, msg.id).catch(() => null);
            const count = full?.reactions?.find(r => (r.emoji.id ?? r.emoji.name) === cfg.emoji)?.count ?? 0;

            if (count >= cfg.threshold) {
                await renderStar(cfg, msg.channelID, msg.id, count);
            } else {
                // fell below threshold — try removing the star post
                const existingId = starred.get(`${cfg.guildId}:${msg.id}`);
                if (existingId) {
                    starred.delete(`${cfg.guildId}:${msg.id}`);
                    await Vaius.rest.channels.deleteMessage(cfg.channelId, existingId).catch(() => null);
                }
            }
            void removed; // refresh handled by the fresh fetch above
        } catch (e) {
            console.error("[starboard] error:", e);
        }
    };

    Vaius.on("messageReactionAdd", async (msg, user, opts) => {
        await handle(msg, user.id, opts, false);
    });
    Vaius.on("messageReactionRemove", async (msg, user, opts) => {
        await handle(msg, user.id, opts, true);
    });
}

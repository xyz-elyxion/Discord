/*
 * Per-guild leveling configuration. The XP engine itself lives in xp.ts
 * (message XP with a 1-minute cooldown, `xp` table keyed by userId). This
 * module controls which guilds earn XP, where level-up announcements go,
 * and provides the leaderboard for the dashboard.
 */

import { Vaius } from "~/Client";
import { db } from "~/db";
import { getLevelForXp, getXpForLevel } from "./xp";

export interface LevelingConfig {
    guildId: string;
    announceChannelId: string | null;
    enabled: boolean;
}

const configs = new Map<string, LevelingConfig>(); // guildId -> cfg

export function getLevelingConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setLevelingConfig(cfg: LevelingConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("levelingConfigs")
        .values({
            guildId: cfg.guildId,
            announceChannelId: cfg.announceChannelId,
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            announceChannelId: cfg.announceChannelId,
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableLevelingConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("levelingConfigs").where("guildId", "=", guildId).execute();
}

export async function getLeaderboard(guildId: string, limit = 10) {
    const rows = await db.selectFrom("xp")
        .selectAll()
        .orderBy("xp", "desc")
        .limit(limit)
        .execute();

    const guild = Vaius.guilds.get(guildId);
    return rows.map((r, i) => {
        const member = guild?.members.get(r.userId);
        const name = member ? (member.nick ?? member.username) : null;
        const level = getLevelForXp(r.xp);
        return {
            rank: i + 1,
            userId: r.userId,
            name,
            xp: r.xp,
            level,
            nextLevelXp: getXpForLevel(level + 1),
        };
    });
}

async function loadLevelingConfigs() {
    const rows = await db.selectFrom("levelingConfigs").selectAll().execute();
    for (const r of rows) {
        if (!r.enabled) continue;
        configs.set(r.guildId, {
            guildId: r.guildId,
            announceChannelId: r.announceChannelId ?? null,
            enabled: true,
        });
    }
    console.log(`[leveling] loaded ${configs.size} guild config(s)`);
}

export function initLeveling() {
    void loadLevelingConfigs();
}

/** Post a level-up announcement for a member, if the guild configured one. */
export async function announceLevelUp(guildId: string, userId: string, level: number) {
    const cfg = getLevelingConfig(guildId);
    if (!cfg || !cfg.enabled || !cfg.announceChannelId) return;
    await Vaius.rest.channels.createMessage(cfg.announceChannelId, {
        content: `🎉 **GG** <@${userId}>, you reached level **${level}**!`,
        allowedMentions: { everyone: false, users: [userId] },
    }).catch(e => console.error("[leveling] announcement failed:", e));
}

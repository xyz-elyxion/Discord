/*
 * Reaction Roles: map emoji -> role per guild. When a member adds/removes
 * one of the configured reactions anywhere in the guild, the matching role
 * is granted/revoked. Managed from the dashboard.
 */

import { MessageReactionAdd, MessageReactionRemove } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface ReactionRoleEntry {
    emoji: string; // unicode emoji or custom emoji id (as string)
    roleId: string;
}

export interface ReactionRoleConfig {
    guildId: string;
    entries: ReactionRoleEntry[];
    enabled: boolean;
}

const configs = new Map<string, ReactionRoleConfig>(); // guildId -> cfg

export function getReactionRolesConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setReactionRolesConfig(cfg: ReactionRoleConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("reactionRoleConfigs")
        .values({
            guildId: cfg.guildId,
            entries: JSON.stringify(cfg.entries),
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            entries: JSON.stringify(cfg.entries),
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableReactionRolesConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("reactionRoleConfigs").where("guildId", "=", guildId).execute();
}

// Reactions arrive as either raw unicode emoji or `<a:name:id>` — normalise
// down to the id for custom emoji, or the raw unicode for defaults.
function normalizeEmoji(emoji: { id: string | null; name: string | null }) {
    return emoji.id ?? emoji.name ?? "";
}

function entryFor(guildId: string, emoji: { id: string | null; name: string | null }) {
    const cfg = configs.get(guildId);
    if (!cfg || !cfg.enabled) return null;
    const norm = normalizeEmoji(emoji);
    return cfg.entries.find(e => e.emoji === norm || e.emoji === emoji.name) ?? null;
}

export function initReactionRoles() {
    void db.selectFrom("reactionRoleConfigs").selectAll().execute().then(rows => {
        for (const r of rows) {
            if (!r.enabled) continue;
            try {
                configs.set(r.guildId, {
                    guildId: r.guildId,
                    entries: JSON.parse(r.entries) as ReactionRoleEntry[],
                    enabled: true,
                });
            } catch (e) {
                console.error("[reaction-roles] failed to parse config for", r.guildId, e);
            }
        }
        console.log(`[reaction-roles] loaded ${configs.size} guild config(s)`);
    });

    const handle = async (
        msg: Parameters<MessageReactionAdd>[0],
        userId: string,
        emoji: { id: string | null; name: string | null },
        add: boolean,
    ) => {
        try {
            const guild = msg.guild;
            if (!guild) return;
            const entry = entryFor(guild.id, emoji);
            if (!entry) return;
            if (!guild.roles.get(entry.roleId)) return;

            const member = await guild.getMember(userId).catch(() => null);
            if (!member || member.bot) return;

            if (add) {
                await member.addRole(entry.roleId, "Reaction Roles").catch(() => null);
            } else {
                await member.removeRole(entry.roleId, "Reaction Roles").catch(() => null);
            }
        } catch (e) {
            console.error("[reaction-roles] error:", e);
        }
    };

    Vaius.on("messageReactionAdd", async (msg, user, opts) => {
        await handle(msg, user.id, (opts as { emoji: { id: string | null; name: string | null } }).emoji, true);
    });
    Vaius.on("messageReactionRemove", async (msg, user, opts) => {
        await handle(msg, user.id, (opts as { emoji: { id: string | null; name: string | null } }).emoji, false);
    });
}

/*
 * Autoroles: roles automatically granted to members when they join a
 * configured guild. Managed from the dashboard (autoroles setup endpoint).
 */

import { Member } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface AutoroleConfig {
    guildId: string;
    roleIds: string[];
    enabled: boolean;
}

const configs = new Map<string, AutoroleConfig>(); // guildId -> cfg

export function getAutoroleConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setAutoroleConfig(cfg: AutoroleConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("autoroleConfigs")
        .values({
            guildId: cfg.guildId,
            roleIds: cfg.roleIds.join(","),
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            roleIds: cfg.roleIds.join(","),
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableAutoroleConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("autoroleConfigs").where("guildId", "=", guildId).execute();
}

export function initAutoroles() {
    void db.selectFrom("autoroleConfigs").selectAll().execute().then(rows => {
        for (const r of rows) {
            if (!r.enabled) continue;
            configs.set(r.guildId, {
                guildId: r.guildId,
                roleIds: r.roleIds.split(",").filter(Boolean),
                enabled: true,
            });
        }
        console.log(`[autoroles] loaded ${configs.size} guild config(s)`);
    });

    Vaius.on("guildMemberAdd", async (member: Member) => {
        try {
            const cfg = configs.get(member.guild.id);
            if (!cfg || !cfg.enabled) return;

            // skip roles that no longer exist or are managed (bot roles etc.)
            const roles = cfg.roleIds.filter(id => member.guild.roles.get(id) && !member.guild.roles.get(id)!.managed);
            if (!roles.length) return;

            await member.edit({ roles, reason: "Autoroles" });
        } catch (e) {
            console.error("[autoroles] error:", e);
        }
    });
}

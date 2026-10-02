/*
 * Welcomer: each configured guild gets a greeting message posted to a chosen
 * channel whenever a member joins. Supports placeholders:
 *   {user}     — mention of the new member
 *   {username} — the member's username
 *   {server}   — the server's name
 *   {count}    — current member count
 */

import { Guild, Member } from "oceanic.js";

import { Vaius } from "~/Client";
import { db } from "~/db";

export interface WelcomerConfig {
    guildId: string;
    channelId: string;
    message: string;
    enabled: boolean;
}

const configs = new Map<string, WelcomerConfig>(); // guildId -> cfg

export function getWelcomerConfig(guildId: string) {
    return configs.get(guildId) ?? null;
}

export async function setWelcomerConfig(cfg: WelcomerConfig, createdBy: string) {
    configs.set(cfg.guildId, cfg);
    await db.insertInto("welcomerConfigs")
        .values({
            guildId: cfg.guildId,
            channelId: cfg.channelId,
            message: cfg.message,
            enabled: cfg.enabled ? 1 : 0,
            createdBy,
            createdAt: new Date().toISOString(),
        })
        .onConflict(oc => oc.column("guildId").doUpdateSet({
            channelId: cfg.channelId,
            message: cfg.message,
            enabled: cfg.enabled ? 1 : 0,
        }))
        .execute();
}

export async function disableWelcomerConfig(guildId: string) {
    configs.delete(guildId);
    await db.deleteFrom("welcomerConfigs").where("guildId", "=", guildId).execute();
}

async function loadWelcomerConfigs() {
    const rows = await db.selectFrom("welcomerConfigs").selectAll().execute();
    for (const r of rows) {
        if (!r.enabled) continue;
        configs.set(r.guildId, {
            guildId: r.guildId,
            channelId: r.channelId,
            message: r.message,
            enabled: true,
        });
    }
    console.log(`[welcomer] loaded ${configs.size} guild config(s)`);
}

export function renderWelcomeMessage(template: string, member: Member, guild: Guild) {
    return template
        .replaceAll("{user}", `<@${member.id}>`)
        .replaceAll("{username}", member.username)
        .replaceAll("{server}", guild.name)
        .replaceAll("{count}", String(guild.memberCount ?? guild.members.size ?? "?"));
}

export function initWelcomer() {
    void loadWelcomerConfigs();

    Vaius.on("guildMemberAdd", async (member: Member) => {
        try {
            const guild = member.guild;
            if (!guild) return;
            const cfg = getWelcomerConfig(guild.id);
            if (!cfg || !cfg.enabled) return;

            const content = renderWelcomeMessage(cfg.message, member, guild);
            await Vaius.rest.channels.createMessage(cfg.channelId, {
                content,
                allowedMentions: { everyone: false, users: [member.id] },
            });
        } catch (e) {
            console.error("[welcomer] error:", e);
        }
    });
}

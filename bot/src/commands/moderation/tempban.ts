import parseDuration from "parse-duration";

import { CommandContext, defineCommand } from "~/Commands";
import Config from "~/config";
import { db } from "~/db";
import { Millis } from "~/constants";
import { silently } from "~/util/functions";
import { msToHumanReadable, toCodeblock } from "~/util/text";

import { resolveUserId } from "~/util/resolvers";
import { getHighestRolePosition, logUserRestriction, ModerationColor, parseUserIdsAndReason, STAFF_ROLES } from "./utils";

const MAX_TEMPBAN = 30 * Millis.DAY;

/**
 * Persists a scheduled unban so it survives bot restarts.
 */
export async function scheduleUnban(guildId: string, userId: string, unbanAt: Date, reason: string, moderatorId: string) {
    await db
        .insertInto("scheduledUnbans")
        .values({
            guildId,
            userId,
            unbanAt: unbanAt.toISOString(),
            reason,
            moderator: moderatorId,
        })
        .onConflict(oc => oc
            .columns(["userId", "guildId"])
            .doUpdateSet({ unbanAt: unbanAt.toISOString(), reason, moderator: moderatorId })
        )
        .execute();
}

/** Runs every minute: unbans everyone whose tempban expired (also handles restarts). */
export function initScheduledUnbans() {
    const check = async () => {
        const due = await db
            .selectFrom("scheduledUnbans")
            .selectAll()
            .where("unbanAt", "<=", new Date().toISOString())
            .execute();

        for (const row of due) {
            try {
                const guild = VaiusGuild(row.guildId);
                if (guild) {
                    await guild.removeBan(row.userId, `Tempban expired: ${row.reason}`);
                    await silently(guild.channels.get(Config.channels.modLog)?.createMessage?.({
                        content: `-# Tempban for <@${row.userId}> expired — automatically unbanned. (reason: ${row.reason})`
                    }));
                }
            } catch (e) {
                // ban may already be gone — either way, don't keep rescheduling
                console.error("[tempban] auto-unban failed:", e);
            }

            await db
                .deleteFrom("scheduledUnbans")
                .where("userId", "=", row.userId)
                .where("guildId", "=", row.guildId)
                .execute();
        }
    };

    setInterval(check, 60_000).unref();
    setTimeout(check, 15_000).unref(); // catch up after restarts
}

// avoid importing Vaius at module top (circular import safety, same pattern as other modules)
function VaiusGuild(guildId: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Vaius } = require("~/Client") as typeof import("~/Client");
    return Vaius.guilds.get(guildId);
}

async function tempbanExecutor({ msg, reply }: CommandContext<true>, args: string[]) {
    const durationString = args.shift();
    const duration = parseDuration(durationString ?? "");

    if (duration == null || duration < Millis.MINUTE || duration > MAX_TEMPBAN) {
        return reply(`Duration must be a valid time span between 1 minute and ${msToHumanReadable(MAX_TEMPBAN)}. Example: \`tempban 3d @user scamming\``);
    }

    const { ids, reason, hasCustomReason } = parseUserIdsAndReason(args);

    if (!ids.length && msg.referencedMessage) {
        ids.push(msg.referencedMessage.author.id);
    }
    if (!ids.length) return reply("Gimme some users silly");
    if (ids.length > 10) return reply("That's tooooo many users....");
    if (!reason) return reply("A reason is required");

    const reasonWithMod = `${msg.author.tag}: ${reason}`;
    const expiresAt = new Date(Date.now() + duration);
    const durationText = msToHumanReadable(duration);

    const members = await msg.guild.fetchMembers({ userIDs: ids });
    const authorHighestRolePosition = getHighestRolePosition(msg.member);

    const fails = [] as string[];
    const bannedUsers = [] as string[];

    await Promise.all(members.map(async member => {
        if (getHighestRolePosition(member) >= authorHighestRolePosition) {
            fails.push(`Failed to tempban **${member.tag}** (${member.mention}): You can't tempban that person!`);
            return;
        }

        await silently(
            member.user.createDM()
                .then(dm => dm.createMessage({
                    content: `You have been banned from the Limey V1 Server for **${durationText}** by ${msg.author.tag.replaceAll("_", "\\_")}. You will be automatically unbanned <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.\n## Reason:\n${toCodeblock(reasonWithMod)}`
                }))
        );

        try {
            await msg.guild.createBan(member.id, { reason: `${reasonWithMod} (tempban, ${durationText})`, deleteMessageDays: 1 });
            await scheduleUnban(msg.guildID, member.id, expiresAt, reason, msg.author.id);
            bannedUsers.push(`**${member.tag}** (${member.mention})`);

            logUserRestriction({
                title: "Temp-banned User",
                user: member.user,
                id: member.id,
                reason,
                moderator: msg.author,
                jumpLink: msg.jumpLink,
                color: ModerationColor.Severe,
                expires: expiresAt,
            });
        } catch (e) {
            fails.push(`Failed to tempban **${member.tag}** (${member.mention}): \`${String(e)}\``);
        }
    }));

    for (const id of ids.filter(id => !members.some(m => m.id === id)))
        fails.push(`Failed to tempban **<@${id}>**: User not found`);

    let content = fails.join("\n") || "Done!";
    if (bannedUsers.length) {
        content += `\n\nTemp-banned ${bannedUsers.join(", ")} for **${durationText}** (until <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)`;
    }

    return reply(content);
}

defineCommand({
    name: "tempban",
    description: "Temporarily ban one or more users; they are automatically unbanned after the duration",
    usage: "<duration> <user> [user...] [reason]",
    aliases: ["tban", "tmpban"],
    guildOnly: true,
    allowedRoles: STAFF_ROLES,
    execute: (ctx, ...args) => tempbanExecutor(ctx, args),
});

defineCommand({
    name: "unbanme",
    description: "List all scheduled (temporary) unbans",
    usage: null,
    aliases: ["tempbans", "scheduledunbans"],
    guildOnly: true,
    allowedRoles: STAFF_ROLES,
    async execute({ msg, reply }: CommandContext<true>) {
        const rows = await db
            .selectFrom("scheduledUnbans")
            .selectAll()
            .where("guildId", "=", msg.guildID)
            .orderBy("unbanAt", "asc")
            .execute();

        if (!rows.length) return reply("No scheduled unbans. 🎉");

        return reply(rows.map(r =>
            `**<@${r.userId}>** — unbanned <t:${Math.floor(new Date(r.unbanAt).getTime() / 1000)}:R> by <@${r.moderator}>\n-# ${r.reason}`
        ).join("\n").slice(0, 2000));
    },
});

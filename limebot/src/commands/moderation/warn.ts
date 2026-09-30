import { MessageTypes } from "oceanic.js";

import Config from "~/config";
import { db } from "~/db";
import { CommandContext, defineCommand } from "~/Commands";
import { getEmoji } from "~/modules/emojiManager";
import { Paginator } from "~/util/Paginator";
import { silently } from "~/util/functions";
import { toCodeblock } from "~/util/text";

import { logUserRestriction, ModerationColor, parseUserIdsAndReason, STAFF_ROLES } from "./utils";

export async function addWarning(guildId: string, userId: string, moderatorId: string, reason: string) {
    await db
        .insertInto("warnings")
        .values({ guildId, userId, moderator: moderatorId, reason, createdAt: new Date().toISOString() })
        .execute();

    const { count } = await db
        .selectFrom("warnings")
        .select(db.fn.countAll<number>().as("count"))
        .where("userId", "=", userId)
        .where("guildId", "=", guildId)
        .executeTakeFirst() ?? { count: 0 };

    return Number(count);
}

export async function getWarnings(userId: string, guildId: string) {
    return db
        .selectFrom("warnings")
        .selectAll()
        .where("userId", "=", userId)
        .where("guildId", "=", guildId)
        .orderBy("id", "desc")
        .execute();
}

async function warnExecutor({ msg, reply }: CommandContext<true>, args: string[]) {
    let { ids, reason, hasCustomReason } = parseUserIdsAndReason(args);

    if (!ids.length && msg.referencedMessage) {
        const target = msg.referencedMessage.type === MessageTypes.AUTO_MODERATION_ACTION
            ? msg.referencedMessage.embeds[0].description!.match(/\d{17,20}/)?.[0]
            : msg.referencedMessage.author.id;

        if (target) {
            ids.push(target);
            if (!hasCustomReason)
                reason = `Warned for message: "${msg.referencedMessage.content.slice(0, 400)}"`;
        }
    }

    if (!ids.length) return reply("Gimme some users silly");
    if (ids.length > 10) return reply("That's tooooo many users....");
    if (!reason) return reply("A reason is required");

    const results = [] as string[];

    for (const id of ids) {
        const count = await addWarning(msg.guildID, id, msg.author.id, reason);

        // AI Mod self-learning: observe staff moderation as training data
        silently(import("~/modules/moderation/aiModLearning").then(m => m.learnFromWarning(msg.guildID, id, reason)));

        logUserRestriction({
            title: `Warned User (#${count} total)`,
            user: msg.guild.members.get(id)?.user,
            id,
            reason,
            moderator: msg.author,
            jumpLink: msg.jumpLink,
            color: ModerationColor.Light,
        });

        results.push(`**<@${id}>** now has **${count}** warning${count === 1 ? "" : "s"}`);

        await silently(
            msg.guild.members.get(id)?.user.createDM()
                .then(dm => dm.createMessage({
                    content: `You have been warned on the Limey V1 Server by ${msg.author.tag.replaceAll("_", "\\_")}.\n## Reason:\n${toCodeblock(`${msg.author.tag}: ${reason}`)}`
                }))
        );
    }

    return reply(`Done! ${getEmoji("BAN")}\n\n${results.join("\n")}`);
}

defineCommand({
    name: "warn",
    description: "Warn one or more users with an optional reason",
    usage: "<user> [user...] [reason]",
    aliases: ["w"],
    guildOnly: true,
    allowedRoles: [Config.roles.mod, Config.roles.helper],
    execute: (ctx, ...args) => warnExecutor(ctx, args),
});

defineCommand({
    name: "warnings",
    description: "View a user's warnings",
    usage: "<user>",
    aliases: ["warns", "warnlist"],
    guildOnly: true,
    allowedRoles: [Config.roles.mod, Config.roles.helper],
    async execute({ msg, reply }: CommandContext<true>, userArg?: string) {
        const id = userArg?.match(/\d{17,20}/)?.[0]
            ?? msg.referencedMessage?.author.id;

        if (!id) return reply("Gimme a user silly");

        const warnings = await getWarnings(id, msg.guildID);
        if (!warnings.length) return reply(`**<@${id}>** has no warnings`);

        const paginator = new Paginator(
            `Warnings for ${id}`,
            warnings,
            3,
            data => data
                .map(w =>
                    `**Warning #${w.id}**\n`
                    + `**Moderator:** <@${w.moderator}>\n`
                    + `**Date:** <t:${Math.floor(new Date(w.createdAt).getTime() / 1000)}:R>\n`
                    + `**Reason:** ${toCodeblock(w.reason)}`
                )
                .join("\n\n")
        );

        return paginator.create(msg);
    },
});

defineCommand({
    name: "delwarn",
    description: "Delete a warning by id",
    usage: "<warningId>",
    aliases: ["removewarn", "clearwarn"],
    guildOnly: true,
    allowedRoles: STAFF_ROLES,
    async execute({ msg, reply }: CommandContext<true>, idArg?: string) {
        const id = Number(idArg);
        if (!id) return reply("Gimme a warning id silly");

        const deleted = await db
            .deleteFrom("warnings")
            .where("id", "=", id)
            .where("guildId", "=", msg.guildID)
            .executeTakeFirst();

        return deleted.numDeletedRows
            ? reply(`Deleted warning **#${id}**`)
            : reply(`Warning **#${id}** not found`);
    },
});

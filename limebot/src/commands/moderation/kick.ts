import { MessageTypes } from "oceanic.js";

import { CommandContext, defineCommand } from "~/Commands";
import Config from "~/config";
import { silently } from "~/util/functions";
import { toCodeblock } from "~/util/text";

import { getHighestRolePosition, logUserRestriction, ModerationColor, parseUserIdsAndReason } from "./utils";

async function kickExecutor({ msg, reply }: CommandContext<true>, args: string[]) {
    let { ids, reason, hasCustomReason } = parseUserIdsAndReason(args);

    if (!ids.length && msg.referencedMessage) {
        const target = msg.referencedMessage.type === MessageTypes.AUTO_MODERATION_ACTION
            ? msg.referencedMessage.embeds[0].description!.match(/\d{17,20}/)?.[0]
            : msg.referencedMessage.author.id;

        if (target) {
            ids.push(target);
            if (!hasCustomReason)
                reason = `Kicked for message: "${msg.referencedMessage.content.slice(0, 400)}"`;
        }
    }

    if (!ids.length) return reply("Gimme some users silly");
    if (ids.length > 20) return reply("That's tooooo many users....");
    if (!reason) return reply("A reason is required");

    const reasonWithMod = `${msg.author.tag}: ${reason}`;

    const members = await msg.guild.fetchMembers({ userIDs: ids });
    const authorHighestRolePosition = getHighestRolePosition(msg.member);

    const fails = [] as string[];
    const kickedUsers = [] as string[];

    await Promise.all(members.map(async member => {
        if (getHighestRolePosition(member) >= authorHighestRolePosition) {
            fails.push(`Failed to kick **${member.tag}** (${member.mention}): You can't kick that person!`);
            return;
        }

        await silently(
            member.user.createDM()
                .then(dm => dm.createMessage({
                    content: `You have been kicked from the Limey V1 Server by ${msg.author.tag.replaceAll("_", "\\_")}.\n## Reason:\n${toCodeblock(reasonWithMod)}`
                }))
        );

        await member.kick(reasonWithMod)
            .then(() => kickedUsers.push(`**${member.tag}** (${member.mention})`))
            .catch(e => fails.push(`Failed to kick **${member.tag}** (${member.mention}): \`${String(e)}\``));

        logUserRestriction({
            title: "Kicked User",
            user: member.user,
            id: member.id,
            reason,
            moderator: msg.author,
            jumpLink: msg.jumpLink,
            color: ModerationColor.Severe,
        });
    }));

    for (const id of ids.filter(id => !members.some(m => m.id === id)))
        fails.push(`Failed to kick **<@${id}>**: User not found`);

    let content = fails.join("\n") || "Done!";
    if (kickedUsers.length) {
        content += `\n\nKicked ${kickedUsers.join(", ")}`;
    }

    return reply(content);
}

defineCommand({
    name: "kick",
    description: "Kick one or more users with an optional reason",
    usage: "<user> [user...] [reason]",
    guildOnly: true,
    allowedRoles: [Config.roles.mod],
    execute: (ctx, ...args) => kickExecutor(ctx, args),
});

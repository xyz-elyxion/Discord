import { MessageFlags } from "oceanic.js";

import { Vaius } from "~/Client";
import { registerChatInputCommand } from "~/SlashCommands";

import Config from "~/config";
import { CommandAttachmentOption, CommandStringOption, CommandUserOption } from "~components";
import { PROD } from "../../constants";
import { fetchBuffer } from "../../util/fetch";

const Name = PROD ? "role-add" : "devrole-add";
const description = "fuck you discord";

registerChatInputCommand(
    {
        name: Name,
        description,
        defaultMemberPermissions: "0",
        options: <>
            <CommandUserOption name="user" required />
            <CommandStringOption name="name" required />
            <CommandStringOption name="color" />
            <CommandStringOption name="icon-url" />
            <CommandAttachmentOption name="icon" />
        </>
    },
    {
        guildOnly: true,
        async handle(i) {
            await i.defer(MessageFlags.EPHEMERAL);

            const opts = i.data.options;
            const user = opts.getUser("user", true);
            const name = opts.getString("name", true);
            const color = opts.getString("color")?.replace(/#/, "") || "000000";
            const iconUrl = opts.getAttachment("icon")?.url || opts.getString("icon-url");

            const iconBuf = !iconUrl
                ? undefined
                : await fetchBuffer(iconUrl);

            const role = await i.guild.createRole({
                name,
                colors: {
                    primaryColor: parseInt(color, 16),
                },
                icon: iconBuf,
                hoist: false,
                mentionable: false,
                reason: `Donor Role for ${user.tag}`,
                permissions: "0"
            });

            // place the new role above the donor role if it exists, otherwise
            // above the bot's highest role that it can manage
            const donorRole = Config.roles.donor ? i.guild.roles.get(Config.roles.donor) : undefined;
            const botMember = i.guild.members.get(Vaius.user.id);
            const botTopRole = botMember
                ? botMember.roles
                    .map(id => i.guild.roles.get(id))
                    .filter((r): r is NonNullable<typeof r> => !!r)
                    .sort((a, b) => b.position - a.position)[0]
                : undefined;
            const referenceRole = donorRole ?? botTopRole ?? Object.values(i.guild.roles).sort((a, b) => b.position - a.position)[0];

            await i.guild.editRolePositions([{
                id: role.id,
                position: referenceRole.position + 1
            }]);

            await i.guild.addMemberRole(user.id, role.id, "Custom Donor Role");
            await i.guild.addMemberRole(user.id, Config.roles.donor, "Donor Role");

            await i.createFollowup({
                content: "Done!",
                flags: MessageFlags.EPHEMERAL
            });
        }
    }
);

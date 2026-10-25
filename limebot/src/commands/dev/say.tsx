import { CreateMessageOptions, MessageFlags } from "oceanic.js";

import { Vaius } from "~/Client";
import { registerChatInputCommand } from "~/SlashCommands";
import { CommandStringOption } from "~components";

registerChatInputCommand(
    {
        name: "say",
        description: "say",
        defaultMemberPermissions: "0",
        options: <>
            <CommandStringOption name="content" description="content" required />
            <CommandStringOption name="reply-to" description="reply" required={false} />
        </>
    },
    {
        ownerOnly: true,
        async handle(i) {
            const content = i.data.options.getString("content", true);
            const reply = i.data.options.getString("reply-to");

            const data: CreateMessageOptions = {
                content,
                messageReference: reply ? {
                    messageID: reply
                } : undefined,
                allowedMentions: {
                    everyone: false,
                    roles: false,
                    repliedUser: true,
                    users: true
                }
            };

            // Acknowledge FIRST — sending the message over REST can be slow,
            // and replying only afterwards expires the interaction (Discord's
            // 3s window) which shows as "The application didn't respond in time".
            await i.defer(MessageFlags.EPHEMERAL);
            try {
                await Vaius.rest.channels.createMessage(i.channelID, data);
                await i.createFollowup({ content: "done", flags: MessageFlags.EPHEMERAL });
            } catch (sendErr) {
                try {
                    await i.createMessage(data);
                } catch (followupErr) {
                    console.error("[say] failed to send the message:", sendErr, followupErr);
                    await i.createFollowup({
                        content: "couldn't send that message — check the bot console",
                        flags: MessageFlags.EPHEMERAL
                    }).catch(() => null);
                }
            }
        }
);


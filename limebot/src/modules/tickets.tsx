import {
    ButtonStyles,
    ChannelTypes,
    CommandInteraction,
    ComponentInteraction,
    ComponentTypes,
    InteractionTypes,
    MessageFlags,
    ModalSubmitInteraction,
    PrivateThreadChannel,
    SeparatorSpacingSize,
    TextChannel,
    TextInputStyles,
} from "oceanic.js";

import { db } from "~/db";
import { handleComponentInteraction, handleInteraction, registerChatInputCommand } from "~/SlashCommands";
import { stripIndent } from "~/util/text";

import { sendDm } from "~/util/discord";
import { run } from "~/util/functions";
import { ActionRow, Button, ComponentMessage, Container, ModalLabel, Separator, TextDisplay, TextInput } from "~components";

import Config from "../config";
import { Vaius } from "../Client";
import { defineCommand } from "../Commands";
import { Emoji, PROD } from "../constants";

// Ticket threads are created under the support channel
const supportChannelId = Config.channels.support;
const { helper: helperRoleId, mod: modRoleId } = Config.tickets;

const enum Ids {
    OPEN_POST = "tickets:post",
    OPEN_SUBMIT = "tickets:open_submit",

    CLOSE = "tickets:close:",
}

const COMMAND_NAME = PROD ? "ticket" : "devticket";

type GuildInteraction = ComponentInteraction<ComponentTypes.BUTTON, TextChannel> | CommandInteraction<TextChannel>;
type ModalInteraction = ComponentInteraction<ComponentTypes.BUTTON, TextChannel> | CommandInteraction<TextChannel> | ModalSubmitInteraction<TextChannel>;

async function createTicket(interaction: GuildInteraction, question?: string) {
    // one open ticket per user
    const existing = await db.selectFrom("tickets")
        .where("userId", "=", interaction.user.id)
        .select(["channelId"])
        .executeTakeFirst();

    if (existing && existing.channelId !== "0") {
        return interaction.createMessage({
            content: `You already have an open ticket: <#${existing.channelId}>`,
            flags: MessageFlags.EPHEMERAL
        });
    }

    // Hard-coded support ticket category — private threads are created under it
    const TICKET_CATEGORY_ID = "1553922850669334600";
    const supportChannel = Vaius.getChannel(TICKET_CATEGORY_ID);
    if (!supportChannel) throw new Error("Support ticket category not found");

    const { channelId, id } = await db.insertInto("tickets")
        .values({
            channelId: "0",
            userId: interaction.user.id
        })
        .onConflict(oc => oc
            .column("userId")
            .doUpdateSet({ id: eb => eb.ref("excluded.id") })
        )
        .returning(["channelId", "id"])
        .executeTakeFirstOrThrow();

    if (channelId !== "0") {
        return interaction.createMessage({
            content: `You already have an open ticket: <#${channelId}>`,
            flags: MessageFlags.EPHEMERAL
        });
    }

    // Discord doesn't allow threads to be created directly in a category —
    // they must hang off a text channel inside it. Find (or create) a text
    // channel in the ticket category and start the thread there.
    const category = supportChannel.type === ChannelTypes.GUILD_CATEGORY
        ? supportChannel
        : supportChannel.parent;
    const guild = "guild" in supportChannel ? supportChannel.guild : interaction.guild;
    let parentTextChannel = guild.channels.find(c =>
        (c.type === ChannelTypes.GUILD_TEXT) && c.parentID === category.id
    ) as TextChannel | undefined;
    if (!parentTextChannel) {
        parentTextChannel = await guild.createChannel("tickets", {
            type: ChannelTypes.GUILD_TEXT,
            parentID: category.id,
            reason: "Auto-created text channel for support tickets"
        }) as TextChannel;
    }

    const thread = await parentTextChannel.startThreadWithoutMessage({
        type: ChannelTypes.PRIVATE_THREAD,
        name: `support-ticket-${id}`,
        invitable: false
    }) as PrivateThreadChannel;

    await db.updateTable("tickets")
        .set("channelId", thread.id)
        .where("id", "=", id)
        .execute();

    // ping helpers so they notice the new ticket
    thread.createMessage({ content: "Notifying helpers..." })
        .then(m => m.edit({
            content: `<@&${helperRoleId}> New support ticket from ${interaction.user.mention}`,
            allowedMentions: { roles: [helperRoleId], users: [interaction.user.id] }
        }))
        .then(m => m.delete());

    await thread.createMessage(
        <ComponentMessage allowedMentions={{ users: [interaction.user.id] }}>
            <Container>
                <TextDisplay>
                    👋 {interaction.user.mention}
                    <br /><br />
                    Thanks for opening a support ticket! Please describe your issue in as much detail as possible.
                    {question && (
                        <>
                            <br /><br />
                            {"**Your question:**"} {question}
                        </>
                    )}
                    <br /><br />
                    A helper will be with you shortly!
                </TextDisplay>

                <Separator spacing={SeparatorSpacingSize.LARGE} />

                <TextDisplay>
                    {`-# Need a moderator instead? Use /modmail in <#${Config.modmail.channelId}>.`}
                </TextDisplay>
            </Container>

            <ActionRow>
                <Button
                    customID={`${Ids.CLOSE}${thread.id}`}
                    style={ButtonStyles.DANGER}
                    emoji={{ name: Emoji.TrashCan }}
                >
                    Close ticket
                </Button>
            </ActionRow>
        </ComponentMessage>
    );

    await interaction.createMessage({
        content: `📩 👉 ${thread.mention}`,
        flags: MessageFlags.EPHEMERAL
    });
}

async function createOpenModal(interaction: CommandInteraction | ComponentInteraction) {
    await interaction.createModal({
        title: "Open a Support Ticket",
        customID: Ids.OPEN_SUBMIT,
        components: <>
            <TextDisplay>
                {stripIndent`
                    Open a private thread with the support team. Use this for **Limey V1 support**!
                    For moderator matters, use modmail instead.
                `}
            </TextDisplay>

            <ModalLabel label="Describe your issue" description="Include any relevant information like error messages or screenshots.">
                <TextInput
                    style={TextInputStyles.PARAGRAPH}
                    placeholder="What do you need help with?"
                    customID="question"
                    minLength={10}
                    maxLength={1000}
                    required
                />
            </ModalLabel>
        </>
    });
}

defineCommand({
    enabled: true,
    name: "tickets:post",
    ownerOnly: true,
    description: "Post the support ticket message",
    usage: null,
    execute() {
        return Vaius.rest.channels.createMessage(supportChannelId,
            <ComponentMessage>
                <Container>
                    <TextDisplay># Support Tickets</TextDisplay>

                    <TextDisplay>
                        Need help with Limey V1 but prefer a private conversation? Open a support ticket!
                        A private thread will be created here where our support team will help you.
                    </TextDisplay>

                    <Separator spacing={SeparatorSpacingSize.LARGE} />

                    <TextDisplay>-# For quick questions, just ask in the channel. For moderator matters, use modmail.</TextDisplay>

                    <ActionRow>
                        <Button
                            style={ButtonStyles.PRIMARY}
                            customID={Ids.OPEN_POST}
                            emoji={{ name: "🎫" }}
                        >
                            Open a Support Ticket
                        </Button>
                    </ActionRow>
                </Container>
            </ComponentMessage>
        );
    }
});

if (true) {
    registerChatInputCommand(
        {
            name: COMMAND_NAME,
            description: "Open a private support ticket",
        },
        {
            guildOnly: true,
            handle: interaction => createOpenModal(interaction as CommandInteraction<TextChannel>)
        }
    );

    handleComponentInteraction({
        customID: Ids.OPEN_POST,
        guildOnly: true,
        handle: interaction => createOpenModal(interaction as ComponentInteraction<ComponentTypes.BUTTON, TextChannel>)
    });

    handleInteraction({
        type: InteractionTypes.MODAL_SUBMIT,
        isMatch: i => i.data.customID === Ids.OPEN_SUBMIT,
        handle: interaction => createTicket(
            interaction as unknown as GuildInteraction,
            (interaction as ModalSubmitInteraction).data.components.getTextInput("question", true)
        )
    });

    handleInteraction({
        type: InteractionTypes.MESSAGE_COMPONENT,
        guildOnly: true,
        isMatch: i => i.data.customID.startsWith(Ids.CLOSE),
        async handle(interaction) {
            if (interaction.channel.type !== ChannelTypes.PRIVATE_THREAD || interaction.channel.threadMetadata.archived)
                return;

            const res = await db.selectFrom("tickets")
                .where("channelId", "=", interaction.channel.id)
                .select(["userId", "id"])
                .executeTakeFirst();
            if (!res) return;

            const isStaff = interaction.member.roles.includes(helperRoleId) || interaction.member.roles.includes(modRoleId);

            // ticket owner or staff can close
            if (res.userId !== interaction.user.id && !isStaff)
                return;

            await interaction.defer(MessageFlags.EPHEMERAL);

            await interaction.channel.edit({ archived: true, locked: true });
            await db.deleteFrom("tickets")
                .where("id", "=", res.id)
                .execute();

            await interaction.createFollowup({
                content: "Ticket closed.",
                flags: MessageFlags.EPHEMERAL
            });

            const member = await interaction.guild.getMember(res.userId).catch(() => null);
            if (!member) return;

            const sentDm = await sendDm(member.user, {
                content: stripIndent`
                    Your support ticket has been closed as resolved.

                    It will remain accessible at ${interaction.channel.mention} for future reference. (If it says \`#unknown\`, just click on it to load it)
                `
            });
            if (!sentDm) {
                await interaction.channel.createMessage({
                    allowedMentions: { users: [member.id] },
                    content: `${member.user.mention} This ticket has been closed as resolved. You can find it again via the Threads tab.`
                });
                await interaction.channel.edit({ archived: true, locked: true });
            }
        }
    });
}

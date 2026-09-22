import { CreateMessageOptions, GuildComponentSelectMenuInteraction, InteractionTypes, MessageFlags, SeparatorSpacingSize, User } from "oceanic.js";
import { ActionRow, ComponentMessage, Container, Separator, StringOption, StringSelect, TextDisplay } from "~components";

import { defineCommand } from "~/Commands";
import { Emoji, SUPPORT_ALLOWED_CHANNELS, LIMEYV1_SITE } from "~/constants";
import { handleInteraction } from "~/SlashCommands";
import { makeCachedJsonFetch } from "~/util/fetch";
import { run, silently } from "~/util/functions";
import { paginators } from "~/util/Paginator";
import { PaginatorCv2 } from "~/util/PaginatorCv2";
import { toInlineCode } from "~/util/text";

interface Faq {
    question: string;
    answer: string;
    tags: string[];
}

export const fetchFaq = makeCachedJsonFetch<Faq[]>(LIMEYV1_SITE + "/faq.json");

export function buildFaqComponents(faq: Faq, invoker: User, options: CreateMessageOptions): CreateMessageOptions {
    return (
        <ComponentMessage {...options}>
            <Container accentColor={0xdd7878}>
                <TextDisplay># {faq.question}</TextDisplay>
                <TextDisplay>{faq.answer}</TextDisplay>

                <Separator spacing={SeparatorSpacingSize.SMALL} />
                <TextDisplay>-# Auto-response invoked by {invoker.tag}</TextDisplay>
            </Container>
        </ComponentMessage>
    );
}

defineCommand({
    name: "faq",
    aliases: ["f"],
    description: "Get an answer from the [FAQ](<https://limey-discord.onrender.com/faq>)",
    usage: "[tag | query]",
    async execute({ msg, createMessage }, query) {
        if (!msg.inCachedGuildChannel()) return;
        if (!SUPPORT_ALLOWED_CHANNELS.includes(msg.channel.id)) return;

        const faq = await fetchFaq();

        const match = run(() => {
            if (!query) return;

            const idx = Number(query);
            if (!isNaN(idx)) return faq[idx - 1];

            query = query.toLowerCase();
            return faq.find(f =>
                f.tags.includes(query) ||
                f.question.toLowerCase().includes(query)
            );
        });

        if (match) {
            const isReply = !!msg.referencedMessage;
            if (isReply) silently(msg.delete());

            return createMessage(
                buildFaqComponents(match, msg.author, {
                    messageReference: { messageID: msg.referencedMessage?.id ?? msg.id },
                    allowedMentions: { repliedUser: isReply }
                })
            );
        }

        const paginator = new PaginatorCv2<Faq>(
            "FAQ Tags",
            faq,
            1,
            async ([data], page) => {
                return (
                    <TextDisplay>
                        {data.answer}
                        <br />
                        -# Tags: {data.tags.map(toInlineCode).join(", ")}
                    </TextDisplay>
                );
            }
        );
        paginator.getTitle = page => faq[page].question;
        paginator.renderTableOfContents = async pageCount => {
            return (
                <>
                    <TextDisplay>{faq.map((faq, i) => `${i + 1}. ${faq.question}`).join("\n")}</TextDisplay>
                    <ActionRow>
                        <StringSelect customID={`faq:select:${paginator.id}`} placeholder="Select a question">
                            {faq.map((faq, idx) => <StringOption label={faq.question} value={String(idx)} />)}
                        </StringSelect>
                    </ActionRow>
                </>);
        };

        await paginator.create(msg);
    },
});

handleInteraction({
    type: InteractionTypes.MESSAGE_COMPONENT,
    isMatch: i => i.data.customID.startsWith("faq:select:"),
    async handle(interaction) {
        const [, , id] = interaction.data.customID.split(":");
        const paginator = paginators.get(id);
        if (!paginator) return;

        if (interaction.user.id !== paginator.userId)
            return interaction.reply({
                content: `This select menu is not for you! ${Emoji.Anger}`,
                flags: MessageFlags.EPHEMERAL
            });

        paginator.navigateTo(Number((interaction as GuildComponentSelectMenuInteraction).data.values.getStrings()[0]));
    }
});

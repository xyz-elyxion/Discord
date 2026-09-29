import { AnyInteractionChannel, AnyInteractionGateway, AnyTextableGuildChannel, ApplicationCommandOptionTypes, ApplicationCommandTypes, ApplicationIntegrationTypes, AutocompleteInteraction, CommandInteraction, ComponentInteraction, ComponentTypes, CreateGuildApplicationCommandOptions, CreateGuildChatInputApplicationCommandOptions, InteractionContextTypes, InteractionTypes, MessageFlags, ModalSubmitInteraction, SelectMenuTypes } from "oceanic.js";

import { SetOptional } from "type-fest";
import { handleError } from ".";
import { CommandContext, Commands } from "./Commands";
import { OwnerId, Vaius } from "./Client";
import Config from "./config";

interface BaseInteractionHandler {
    ownerOnly?: boolean;
    guildOnly?: boolean;
    allowedRoles?: string[];
}
interface AnyInteractionHandler extends BaseInteractionHandler {
    handle(interaction: AnyInteractionGateway): any;
}

type CommandHandler = {
    guildOnly?: false;
    handle(interaction: CommandInteraction): any;
    autoComplete?(interaction: AutocompleteInteraction): any;
} | {
    guildOnly: true;
    handle(interaction: CommandInteraction<AnyTextableGuildChannel>): any;
    autoComplete?(interaction: AutocompleteInteraction<AnyTextableGuildChannel>): any;
};

export type CommandInteractionHandler = BaseInteractionHandler & CommandHandler;
export type NamedCommandInteractionHandler = CommandInteractionHandler & { name: string; };

type ComponentHandler = {
    guildOnly?: false;
    handle(interaction: ComponentInteraction): any;
} | {
    guildOnly: true;
    handle(interaction: ComponentInteraction<ComponentTypes.BUTTON | SelectMenuTypes, AnyTextableGuildChannel>): any;
};

export type ComponentInteractionHandler = BaseInteractionHandler & ComponentHandler & {
    customID: string;
};

export interface InteractionTypeMap<GuildOnly extends Boolean> {
    [InteractionTypes.APPLICATION_COMMAND]: CommandInteraction<GuildOnly extends true ? AnyTextableGuildChannel : AnyInteractionChannel>;
    [InteractionTypes.MESSAGE_COMPONENT]: ComponentInteraction<ComponentTypes.BUTTON | SelectMenuTypes, GuildOnly extends true ? AnyTextableGuildChannel : AnyInteractionChannel>;
    [InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE]: AutocompleteInteraction<GuildOnly extends true ? AnyTextableGuildChannel : AnyInteractionChannel>;
    [InteractionTypes.MODAL_SUBMIT]: ModalSubmitInteraction<GuildOnly extends true ? AnyTextableGuildChannel : AnyInteractionChannel>;
    [InteractionTypes.PING]: never;
}

export type CustomHandler<T extends AnyInteractionGateway> = {
    isMatch(interaction: T): boolean;
    handle(interaction: T): any;
};

type AnyCustomHandler = CustomHandler<AnyInteractionGateway>;

const CustomHandlers = {} as Partial<Record<InteractionTypes, AnyCustomHandler[]>>;
const CommandHandlers = {} as Record<string, CommandInteractionHandler>;
const ComponentHandlers = {} as Record<string, ComponentInteractionHandler>;

export function handleCommandInteraction(handler: NamedCommandInteractionHandler) {
    CommandHandlers[handler.name] = handler;
}

export function handleComponentInteraction(handler: ComponentInteractionHandler) {
    ComponentHandlers[handler.customID] = handler;
}

export function handleInteraction<T extends InteractionTypes, GuildOnly extends boolean>(handler: { type: T, guildOnly?: GuildOnly; } & CustomHandler<InteractionTypeMap<GuildOnly>[T]>) {
    CustomHandlers[handler.type] ??= [];
    CustomHandlers[handler.type]!.push(handler);
}

function resolveHandler(interaction: AnyInteractionGateway): AnyInteractionHandler | undefined {
    return (
        (interaction.type === InteractionTypes.APPLICATION_COMMAND && CommandHandlers[interaction.data.name]) ||
        (interaction.type === InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE && CommandHandlers[interaction.data.name]) ||
        (interaction.type === InteractionTypes.MESSAGE_COMPONENT && ComponentHandlers[interaction.data.customID]) ||
        CustomHandlers[interaction.type]?.find(handler => handler.isMatch(interaction as any))
    );
}

Vaius.on("interactionCreate", async interaction => {
    const handler = resolveHandler(interaction);
    if (!handler) return;
    if (handler.ownerOnly && interaction.user.id !== OwnerId) return;
    if (handler.guildOnly && !interaction.inCachedGuildChannel()) return;

    if (handler.allowedRoles) {
        if (!interaction.inCachedGuildChannel()) return;

        if (!handler.allowedRoles.some(r => interaction.member.roles.includes(r)))
            return;
    }

    try {
        if (interaction.type === InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE)
            await (handler as CommandHandler).autoComplete!(interaction as AutocompleteInteraction<any>);
        else
            await handler.handle(interaction);
    } catch (e) {
        handleError("Error handling interaction", e);

        // Interactions expire 3 seconds after they are sent. If the bot was
        // slow (rate limits, proxy latency, restarts), Discord has already
        // invalidated the interaction/webhook token — nothing to reply to.
        const isExpired = (e as any)?.code === 10062 /* Unknown interaction */
            || (e as any)?.code === 10015 /* Unknown webhook */;
        if (isExpired) return;

        if (interaction.type === InteractionTypes.APPLICATION_COMMAND) {
            const message = "oop, that didn't go well 💥";

            try {
                if (interaction.acknowledged) {
                    await interaction.createFollowup({
                        content: message,
                        flags: MessageFlags.EPHEMERAL
                    });
                } else {
                    await interaction.createMessage({
                        content: message,
                        flags: MessageFlags.EPHEMERAL
                    });
                }
            } catch (replyErr: any) {
                if (replyErr?.code !== 10062 && replyErr?.code !== 10015)
                    throw replyErr;
            }
        }
    }
});

const SlashCommands = [] as CreateGuildApplicationCommandOptions[];

export function registerMessageCommand(handler: NamedCommandInteractionHandler) {
    SlashCommands.push({
        type: ApplicationCommandTypes.MESSAGE,
        name: handler.name,
    });

    handleCommandInteraction(handler);
}

export type ChatInputCommandOptions = SetOptional<Omit<CreateGuildChatInputApplicationCommandOptions, "type">, "description">;

export function registerChatInputCommand(options: ChatInputCommandOptions, handler: CommandInteractionHandler) {
    SlashCommands.push({
        type: ApplicationCommandTypes.CHAT_INPUT,
        ...options,
        description: options.description || "No description provided"
    });

    handleCommandInteraction({
        name: options.name,
        ...handler
    });
}

Vaius.once("ready", async () => {
    try {
        await Vaius.application.bulkEditGuildCommands(Config.homeGuildId, SlashCommands);

        await Vaius.application.bulkEditGlobalCommands(SlashCommands.map(cmd => ({
            ...cmd,
            integrationTypes: [ApplicationIntegrationTypes.USER_INSTALL],
            contexts: [InteractionContextTypes.BOT_DM, InteractionContextTypes.GUILD, InteractionContextTypes.PRIVATE_CHANNEL],
        })));
    } catch (e) {
        console.error("Failed to register slash commands (is the bot in homeGuildId with the applications.commands scope?)", e);
    }
});

// ---------------------------------------------------------------------------
// Prefix command → slash command bridge
//
// Lets any prefix command be used as a slash command without rewriting its
// executor: the interaction is adapted into a CommandContext and the slash
// options are flattened back into the string args the executor expects.
// ---------------------------------------------------------------------------

type SlashOptionSpec =
    | { type: "user"; name: string; description: string; required?: boolean }
    | { type: "string"; name: string; description: string; required?: boolean }
    | { type: "int"; name: string; description: string; required?: boolean; min?: number; max?: number }
    | { type: "channel"; name: string; description: string; required?: boolean }
    | { type: "raw"; name: string; description: string; required?: boolean }; // rest of args as one string (rawContent commands)

const BridgeCommands = new Map<string, { options: SlashOptionSpec[]; dmAllowed: boolean; }>();

function convertInteractionOptionsToArgs(specs: SlashOptionSpec[], interaction: CommandInteraction<AnyTextableGuildChannel>) {
    const args: string[] = [];
    const opts = interaction.data.options;

    for (const spec of specs) {
        let value: string | number | undefined;
        switch (spec.type) {
            case "user": value = opts.getUser(spec.name)?.id; break;
            case "int": value = opts.getNumber(spec.name); break;
            case "channel": value = opts.getChannel(spec.name)?.id; break;
            case "raw":
            case "string": value = opts.getString(spec.name); break;
        }

        if (value != null) args.push(String(value));
    }

    return args;
}

export function bridgeSlashCommand(cmdName: string, options: SlashOptionSpec[], dmAllowed = false) {
    const cmd = Commands[cmdName];
    if (!cmd) throw new Error(`Cannot bridge "${cmdName}": no such command`);

    BridgeCommands.set(cmdName, { options, dmAllowed });

    const isRaw = options.some(o => o.type === "raw");

    SlashCommands.push({
        type: ApplicationCommandTypes.CHAT_INPUT,
        name: cmdName,
        description: cmd.description.slice(0, 100) || "No description provided",
        options: options.map(o => ({
            type: o.type === "user" ? ApplicationCommandOptionTypes.USER
                : o.type === "int" ? ApplicationCommandOptionTypes.INTEGER
                : o.type === "channel" ? ApplicationCommandOptionTypes.CHANNEL
                : ApplicationCommandOptionTypes.STRING,
            name: o.name,
            description: o.description.slice(0, 100),
            required: o.type === "raw" ? false : (o.required ?? false),
            ...(o.type === "int" ? { minValue: o.min, maxValue: o.max } : {}),
        }))
    } as any);

    handleCommandInteraction({
        name: cmdName,
        guildOnly: !dmAllowed,
        allowedRoles: cmd.allowedRoles,
        ownerOnly: cmd.ownerOnly,
        async handle(interaction) {
            const args = convertInteractionOptionsToArgs(options, interaction as CommandInteraction<AnyTextableGuildChannel>);

            const context = new CommandContext(
                null as any, // no message — replies go through the interaction
                "/",
                cmdName,
            );

            // Route the context's replies through the interaction webhooks so
            // slash replies work without an originating message.
            (context as any).msg = makeInteractionMessageShim(interaction as CommandInteraction<AnyTextableGuildChannel>);

            await (isRaw
                ? cmd.execute(context, args.join(" "))
                : cmd.execute(context, ...args));
        }
    });
}

// minimal Message shim: only what CommandContext.reply/react need
function makeInteractionMessageShim(interaction: CommandInteraction) {
    return {
        id: interaction.id,
        channelID: interaction.channelID,
        guildID: interaction.guildID,
        jumpLink: null,
        author: interaction.user,
        member: interaction.member,
        guild: interaction.guild,
        client: interaction.client,
        content: "",
        createReaction: async () => { },
    } as any;
}

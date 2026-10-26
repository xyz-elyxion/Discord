/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, MessageActions, MessageStore } from "@webpack/common";

import { blackjackTotal, type Card, createDeck, formatCard, formatHand, rankValue } from "./cards";
import {
    crashBustPoint,
    crashMultiplierAt,
    type DiceMode,
    diceMultiplier,
    diceWins,
    dropPlinko,
    flipCoin,
    LUCK_MULTIPLIERS,
    LUCK_SEATS,
    luckMultiplier,
    MINES_TILES,
    minesMultiplier,
    parseRouletteBet,
    placeMines,
    PLINKO_ROWS,
    plinkoMultipliers,
    rollDice,
    rouletteColor,
    slotsResult,
    spinRoulette,
    spinSlots
} from "./games";
import { randomInt } from "./rng";
import { addCoins, checkBet, formatCoins, formatMultiplier, getBalance, placeBet, setBalance, STARTING_BALANCE } from "./wallet";

const logger = new Logger("Casino");

const settings = definePluginSettings({
    publicMessages: {
        type: OptionType.BOOLEAN,
        description: "Post rounds as real channel messages that everyone can see, instead of private bot-style messages only you see",
        default: false
    }
});

/* Round state — one round per channel at a time */

interface BlackjackGame {
    bet: number;
    deck: Card[];
    player: Card[];
    dealer: Card[];
    messageId?: string;
    opponentId?: string;
    doubled: boolean;
    canDouble: boolean;
}

interface CoinflipRound {
    bet: number;
    messageId?: string;
    opponentId?: string;
}

interface CrashRound {
    bet: number;
    bustAt: number;
    startedAt: number;
    messageId?: string;
    opponentId?: string;
    finished: boolean;
    timer?: ReturnType<typeof setInterval>;
}

interface HigherLowerRound {
    bet: number;
    deck: Card[];
    card: Card;
    messageId?: string;
    opponentId?: string;
}

interface LuckGame {
    bet: number;
    cleared: Set<number>;
    dud: number;
    messageId?: string;
    opponentId?: string;
}

interface MinesGame {
    bet: number;
    mines: Set<number>;
    revealed: Set<number>;
    messageId?: string;
    opponentId?: string;
}

const blackjackGames = new Map<string, BlackjackGame>();
const coinflipRounds = new Map<string, CoinflipRound>();
const crashRounds = new Map<string, CrashRound>();
const higherLowerRounds = new Map<string, HigherLowerRound>();
const luckGames = new Map<string, LuckGame>();
const minesGames = new Map<string, MinesGame>();

/* Message helpers */

const COLOUR_EMOJI = { red: "🔴", black: "⚫", green: "🟢" } as const;
const SEAT_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

function lastMessageId(channelId: string): string | undefined {
    const messages = MessageStore.getMessages(channelId)?._map;
    if (!messages) return undefined;

    return Object.keys(messages).at(-1);
}

function post(channelId: string, content: string): string | undefined {
    if (settings.store.publicMessages) sendMessage(channelId, { content });
    else sendBotMessage(channelId, { content });

    return lastMessageId(channelId);
}

function edit(channelId: string, messageId: string | undefined, content: string) {
    const message = messageId ? MessageStore.getMessage(channelId, messageId) : undefined;
    if (!message) {
        post(channelId, content);
        return;
    }

    // Locally injected bot messages only live in the store, real messages have to be edited properly
    if (message.id.startsWith("-")) {
        FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", message: { ...message, content } });
        return;
    }

    try {
        MessageActions.editMessage(channelId, message.id, { content });
    } catch (error) {
        logger.error("Failed to edit a casino message, posting a new one instead", error);
        post(channelId, content);
    }
}

async function finish(channelId: string, messageId: string | undefined, payout: number, content: string) {
    const balance = await addCoins(payout);
    edit(channelId, messageId, `${content}\n\nBalance: **${formatCoins(balance)}**`);
}

function outcomeLine(payout: number, bet: number) {
    if (payout > bet) return `✅ **Won ${formatCoins(payout - bet)}**`;
    if (payout === bet) return `↔️ **Push** — your ${formatCoins(bet)} comes back`;
    if (payout === 0) return `❌ **Lost ${formatCoins(bet)}**`;

    return `❌ **Lost ${formatCoins(bet - payout)}**`;
}

function capitalise(text: string) {
    return text[0].toUpperCase() + text.slice(1);
}

function draw(deck: Card[]): Card {
    return deck.pop()!;
}

/* Blackjack */

function blackjackText(game: BlackjackGame, revealDealer: boolean, footer: string) {
    const dealerHand = revealDealer ? formatHand(game.dealer) : `${formatCard(game.dealer[0])} 🂠`;
    const lines = [
        "🃏 **Blackjack**",
        `Bet: **${formatCoins(game.bet)}**${game.doubled ? " (doubled)" : ""}`,
        "",
        `Dealer: ${dealerHand}`,
        `You: ${formatHand(game.player)}`
    ];

    if (footer) lines.push("", footer);

    return lines.join("\n");
}

function dealerPlay(game: BlackjackGame) {
    while (blackjackTotal(game.dealer) < 17) game.dealer.push(draw(game.deck));
}

async function settleBlackjack(channelId: string, game: BlackjackGame, natural = false) {
    blackjackGames.delete(channelId);

    const playerTotal = blackjackTotal(game.player);
    const dealerTotal = blackjackTotal(game.dealer);
    let payout = 0;
    let footer: string;

    if (playerTotal > 21) {
        footer = `💥 **Bust** — ${outcomeLine(0, game.bet)}`;
    } else if (natural) {
        payout = Math.floor(game.bet * 2.5);
        footer = `🎉 **Blackjack!** ${outcomeLine(payout, game.bet)}`;
    } else if (dealerTotal > 21) {
        payout = game.bet * 2;
        footer = `🏆 **Dealer busts** — ${outcomeLine(payout, game.bet)}`;
    } else if (playerTotal > dealerTotal) {
        payout = game.bet * 2;
        footer = `🏆 **You win** — ${outcomeLine(payout, game.bet)}`;
    } else if (playerTotal === dealerTotal) {
        payout = game.bet;
        footer = `↔️ **Push** — your ${formatCoins(game.bet)} comes back`;
    } else {
        footer = outcomeLine(0, game.bet);
    }

    await finish(channelId, game.messageId, payout, blackjackText(game, true, footer));
}

/* Crash */

function crashText(round: CrashRound, multiplier: number, footer: string) {
    return [
        "🚀 **Crash**",
        `Bet: **${formatCoins(round.bet)}**`,
        `Multiplier: **${formatMultiplier(multiplier)}** · Cash out value: **${formatCoins(Math.floor(round.bet * multiplier))}**`,
        "",
        footer
    ].join("\n");
}

function stopCrashTimer(round: CrashRound) {
    if (round.timer) {
        clearInterval(round.timer);
        round.timer = undefined;
    }
}

async function endCrash(channelId: string, round: CrashRound, payout: number, footer: string, multiplier: number) {
    if (round.finished) return;

    round.finished = true;
    stopCrashTimer(round);
    crashRounds.delete(channelId);

    await finish(channelId, round.messageId, payout, crashText(round, multiplier, footer));
}

/* Mines */

function minesText(game: MinesGame, footer: string, revealMines = false, hit?: number) {
    const multiplier = minesMultiplier(game.mines.size, game.revealed.size);
    const rows: string[] = [];

    for (let row = 0; row < 5; row++) {
        const cells: string[] = [];

        for (let column = 0; column < 5; column++) {
            const index = row * 5 + column;

            if (index === hit) cells.push("💥");
            else if (game.revealed.has(index)) cells.push(game.mines.has(index) ? "💣" : "💎");
            else if (revealMines) cells.push(game.mines.has(index) ? "💣" : "💎");
            else cells.push(`\`${String(index + 1).padStart(2, "0")}\``);
        }

        rows.push(cells.join(" "));
    }

    return [
        "💣 **Mines**",
        `Bet: **${formatCoins(game.bet)}** · Mines: **${game.mines.size}** · Safe picks: **${game.revealed.size}**`,
        `Multiplier: **${formatMultiplier(multiplier)}** · Cash out value: **${formatCoins(Math.floor(game.bet * multiplier))}**`,
        "",
        rows.join("\n"),
        "",
        footer
    ].join("\n");
}

/* Higher or lower */

function higherLowerText(round: HigherLowerRound, footer: string) {
    return [
        "🃏 **Higher or Lower**",
        `Current card: **${formatCard(round.card)}**`,
        `Bet: **${formatCoins(round.bet)}**`,
        "",
        footer
    ].join("\n");
}

/* Lucky seats */

function luckText(game: LuckGame, footer: string, revealDud = false) {
    const seats = SEAT_EMOJI.map((emoji, index) => {
        if (game.cleared.has(index)) return "✅";
        if (revealDud && index === game.dud) return "💥";

        return emoji;
    }).join(" ");

    const cleared = game.cleared.size;
    const multiplier = luckMultiplier(cleared);
    const round = Math.min(cleared + 1, LUCK_MULTIPLIERS.length);

    return [
        "🍀 **Lucky Seats** — a non-violent elimination luck game",
        `Bet: **${formatCoins(game.bet)}** · Round **${round}/${LUCK_MULTIPLIERS.length}** · Cleared: **${cleared}**`,
        seats,
        `Multiplier: **${formatMultiplier(multiplier)}** · Cash out value: **${formatCoins(Math.floor(game.bet * multiplier))}**`,
        "",
        footer
    ].join("\n");
}

function rollDud(cleared: Set<number>) {
    const remaining = Array.from({ length: LUCK_SEATS }, (_, index) => index).filter(index => !cleared.has(index));
    return remaining[randomInt(remaining.length)];
}

export default definePlugin({
    name: "Casino",
    description: "Adds 10 virtual gambling commands (coinflip, blackjack, roulette, slots, crash, mines, plinko, dice, higher or lower, lucky seats) that run from Discord's built-in command menu and play with local coins — no bot, no real money",
    searchTerms: ["gambling", "bet", "casino", "coins", "coinflip"],
    tags: ["Fun", "Commands"],
    authors: [Devs.Limey],
    dependencies: ["CommandsAPI"],
    permissions: [
        {
            id: "registerCommands",
            title: "Register chat commands",
            description: "Adds the casino slash commands to Discord's built-in command menu.",
            risk: "Command options you fill in are read by this plugin."
        },
        {
            id: "sendMessage",
            title: "Post messages in your channels",
            description: "Posts game messages — private bot-style messages by default, or real channel messages if you enable that in the plugin settings.",
            risk: "With public messages enabled, game messages are sent from your account and everyone in the channel can see them."
        },
        {
            id: "localDataStore",
            title: "Store your coin balance",
            description: "Keeps your virtual coin balance in Limey V1's local data store.",
            risk: "Only a single number is stored, locally on this device."
        }
    ],
    settings,

    start() {
        logger.info("Casino is ready — all games use virtual coins only");
    },

    stop() {
        for (const round of crashRounds.values()) stopCrashTimer(round);

        blackjackGames.clear();
        coinflipRounds.clear();
        crashRounds.clear();
        higherLowerRounds.clear();
        luckGames.clear();
        minesGames.clear();
    },

    commands: [
        {
            name: "coinflip",
            description: "Bet virtual coins on a coin flip — heads or tails",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                },
                {
                    name: "choice",
                    description: "The side you're betting on — leave empty to be asked first",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Heads", value: "heads", label: "Heads" },
                        { name: "Tails", value: "tails", label: "Tails" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person you're challenging (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const choice = String(findOption<string>(args, "choice") ?? "").toLowerCase();
                const pending = coinflipRounds.get(channel.id);

                if (choice !== "heads" && choice !== "tails") {
                    if (pending)
                        return sendBotMessage(channel.id, { content: "There's already a coinflip waiting in this channel. Run `/coinflip` again with the **choice** option set." });

                    const betCheck = await checkBet(findOption(args, "bet"));
                    if ("error" in betCheck) return sendBotMessage(channel.id, { content: betCheck.error });

                    const opponentId = findOption<string>(args, "opponent");
                    const messageId = post(channel.id, [
                        `🪙 **Coinflip** — what do you want to bet on?${opponentId ? ` <@${opponentId}>` : ""}`,
                        `Bet: **${formatCoins(betCheck.bet)}**`,
                        "",
                        opponentId
                            ? `<@${opponentId}>, call it: **heads** or **tails**? Then run \`/coinflip\` again with their pick — this message turns into the result.`
                            : "Run `/coinflip` again with the **choice** option set to **heads** or **tails**. This message turns into the result."
                    ].join("\n"));

                    coinflipRounds.set(channel.id, { bet: betCheck.bet, messageId, opponentId });
                    return;
                }

                const betResult = await placeBet(pending?.bet ?? findOption(args, "bet"));
                if ("error" in betResult) {
                    coinflipRounds.delete(channel.id);
                    return sendBotMessage(channel.id, { content: betResult.error });
                }

                coinflipRounds.delete(channel.id);

                const result = flipCoin();
                const won = result === choice;
                const payout = won ? betResult.bet * 2 : 0;
                const opponentId = pending?.opponentId;

                await finish(channel.id, pending?.messageId, payout, [
                    `🪙 **Coinflip** — it landed on **${capitalise(result)}**`,
                    `You bet **${formatCoins(betResult.bet)}** on **${capitalise(choice)}**${opponentId ? ` against <@${opponentId}>` : ""}`,
                    "",
                    outcomeLine(payout, betResult.bet)
                ].join("\n"));
            }
        },

        {
            name: "blackjack",
            description: "Play cards against the dealer and try to reach 21",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet when starting a hand",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "action",
                    description: "What to do with the hand you already have — use what the other player calls",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Hit", value: "hit", label: "Hit" },
                        { name: "Stand", value: "stand", label: "Stand" },
                        { name: "Double down", value: "double", label: "Double down" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person who decides your hits and stands (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const action = String(findOption<string>(args, "action") ?? "").toLowerCase();
                const game = blackjackGames.get(channel.id);

                if (!game) {
                    if (action)
                        return sendBotMessage(channel.id, { content: "There's no blackjack hand running in this channel. Start one with `/blackjack`." });

                    const betResult = await placeBet(findOption(args, "bet"));
                    if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                    const deck = createDeck();
                    const newGame: BlackjackGame = {
                        bet: betResult.bet,
                        deck,
                        player: [draw(deck), draw(deck)],
                        dealer: [draw(deck), draw(deck)],
                        opponentId: findOption<string>(args, "opponent"),
                        doubled: false,
                        canDouble: true
                    };

                    newGame.messageId = post(channel.id, blackjackText(newGame, false, "Dealing…"));
                    blackjackGames.set(channel.id, newGame);

                    const playerTotal = blackjackTotal(newGame.player);
                    const dealerTotal = blackjackTotal(newGame.dealer);

                    if (playerTotal === 21 || dealerTotal === 21)
                        return settleBlackjack(channel.id, newGame, playerTotal === 21 && dealerTotal !== 21);

                    return edit(channel.id, newGame.messageId, blackjackText(newGame, false, newGame.opponentId
                        ? `Ask <@${newGame.opponentId}>: \`hit\`, \`stand\` or \`double\`? Then run \`/blackjack\` again with their choice.`
                        : "Run `/blackjack` again with **action** set to `hit`, `stand` or `double`."));
                }

                switch (action) {
                    case "hit": {
                        game.player.push(draw(game.deck));
                        game.canDouble = false;

                        const total = blackjackTotal(game.player);
                        if (total > 21) return settleBlackjack(channel.id, game);

                        if (total === 21) {
                            dealerPlay(game);
                            return settleBlackjack(channel.id, game);
                        }

                        return edit(channel.id, game.messageId, blackjackText(game, false, game.opponentId
                            ? `Ask <@${game.opponentId}>: \`hit\` or \`stand\`? Then run \`/blackjack\` again with their choice.`
                            : "Run `/blackjack` again with **action** set to `hit` or `stand`."));
                    }

                    case "stand": {
                        dealerPlay(game);
                        return settleBlackjack(channel.id, game);
                    }

                    case "double": {
                        if (!game.canDouble || game.player.length !== 2)
                            return sendBotMessage(channel.id, { content: "You can only double down on your first two cards." });

                        const doubleBet = await placeBet(game.bet);
                        if ("error" in doubleBet) return sendBotMessage(channel.id, { content: doubleBet.error });

                        game.bet += doubleBet.bet;
                        game.doubled = true;
                        game.canDouble = false;
                        game.player.push(draw(game.deck));

                        if (blackjackTotal(game.player) <= 21) dealerPlay(game);

                        return settleBlackjack(channel.id, game);
                    }

                    default:
                        return sendBotMessage(channel.id, { content: "Pick an **action**: `hit`, `stand` or `double`." });
                }
            }
        },

        {
            name: "roulette",
            description: "Bet on a roulette number, colour, range or dozen",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                },
                {
                    name: "value",
                    description: "red / black / 0-36 / 1-18 / 19-36 / 1-12 / 13-24 / 25-36",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "type",
                    description: "What kind of bet this is — guessed from the value when left empty",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Colour", value: "color", label: "Colour" },
                        { name: "Number", value: "number", label: "Number" },
                        { name: "Range", value: "range", label: "Range" },
                        { name: "Dozen", value: "dozen", label: "Dozen" }
                    ]
                }
            ],
            async execute(args, { channel }) {
                const betSpec = parseRouletteBet(findOption<string>(args, "type"), findOption<string>(args, "value"));
                if ("error" in betSpec) return sendBotMessage(channel.id, { content: betSpec.error });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const number = spinRoulette();
                const colour = rouletteColor(number);
                const won = betSpec.covers(number);
                const payout = won ? Math.floor(betResult.bet * betSpec.multiplier) : 0;

                await finish(channel.id, undefined, payout, [
                    `🎡 **Roulette** — the ball landed on **${number} ${COLOUR_EMOJI[colour]}**`,
                    `You bet **${formatCoins(betResult.bet)}** on **${betSpec.label}** (${formatMultiplier(betSpec.multiplier)})`,
                    "",
                    outcomeLine(payout, betResult.bet)
                ].join("\n"));
            }
        },

        {
            name: "slots",
            description: "Spin the reels and match symbols for virtual rewards",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                }
            ],
            async execute(args, { channel }) {
                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const reels = spinSlots();
                const { multiplier, description } = slotsResult(reels);
                const payout = Math.floor(betResult.bet * multiplier);

                await finish(channel.id, undefined, payout, [
                    "🎰 **Slots**",
                    reels.map(reel => reel.symbol).join("  │  "),
                    `Bet **${formatCoins(betResult.bet)}** · ${description} (${formatMultiplier(multiplier)})`,
                    "",
                    outcomeLine(payout, betResult.bet)
                ].join("\n"));
            }
        },

        {
            name: "crash",
            description: "Watch a multiplier climb and cash out before the rocket crashes",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet when starting a round",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "action",
                    description: "Cash out of the round that's already running",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Cash out", value: "cashout", label: "Cash out" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person who calls the next move (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const action = String(findOption<string>(args, "action") ?? "").toLowerCase();
                const round = crashRounds.get(channel.id);

                if (action === "cashout") {
                    if (!round)
                        return sendBotMessage(channel.id, { content: "There's no crash round running in this channel. Start one with `/crash`." });

                    const multiplier = crashMultiplierAt(Date.now() - round.startedAt);
                    if (multiplier >= round.bustAt)
                        return endCrash(channel.id, round, 0, `💥 **Crashed at ${formatMultiplier(round.bustAt)}** — ${outcomeLine(0, round.bet)}`, round.bustAt);

                    const payout = Math.floor(round.bet * multiplier);
                    return endCrash(channel.id, round, payout, `💰 **Cashed out at ${formatMultiplier(multiplier)}** — ${outcomeLine(payout, round.bet)}`, multiplier);
                }

                if (round)
                    return sendBotMessage(channel.id, { content: "A crash round is already running in this channel. Run `/crash` again with **action** set to `cashout` to take your winnings." });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const newRound: CrashRound = {
                    bet: betResult.bet,
                    bustAt: crashBustPoint(),
                    startedAt: Date.now(),
                    opponentId: findOption<string>(args, "opponent"),
                    finished: false
                };
                const footer = newRound.opponentId
                    ? `Ask <@${newRound.opponentId}> when to cash out, then run \`/crash\` again with **action** set to \`cashout\`.`
                    : "Run `/crash` again with **action** set to `cashout` to lock in your winnings.";

                newRound.messageId = post(channel.id, crashText(newRound, 1, footer));
                crashRounds.set(channel.id, newRound);

                newRound.timer = setInterval(() => {
                    if (newRound.finished) return;

                    const multiplier = crashMultiplierAt(Date.now() - newRound.startedAt);
                    if (multiplier >= newRound.bustAt) {
                        void endCrash(channel.id, newRound, 0, `💥 **Crashed at ${formatMultiplier(newRound.bustAt)}** — ${outcomeLine(0, newRound.bet)}`, newRound.bustAt);
                        return;
                    }

                    edit(channel.id, newRound.messageId, crashText(newRound, multiplier, footer));
                }, 700);
            }
        },

        {
            name: "mines",
            description: "Reveal tiles while dodging hidden mines, then cash out",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet when starting a board",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "mines",
                    description: "How many mines to hide, 1-24 (defaults to 3)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "tile",
                    description: "The tile to reveal, 1-25 — the one the other player picked",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "action",
                    description: "Cash out of the board that's already running",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Cash out", value: "cashout", label: "Cash out" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person who picks the tiles (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const action = String(findOption<string>(args, "action") ?? "").toLowerCase();
                const game = minesGames.get(channel.id);

                if (action === "cashout") {
                    if (!game)
                        return sendBotMessage(channel.id, { content: "There's no mines board in this channel. Start one with `/mines`." });

                    const payout = Math.floor(game.bet * minesMultiplier(game.mines.size, game.revealed.size));
                    minesGames.delete(channel.id);

                    return finish(channel.id, game.messageId, payout, minesText(game, `💰 **Cashed out** — ${outcomeLine(payout, game.bet)}`, true));
                }

                const tile = findOption<number>(args, "tile");

                if (tile != null) {
                    if (!game)
                        return sendBotMessage(channel.id, { content: "There's no mines board in this channel. Start one with `/mines`." });

                    const index = Math.floor(Number(tile)) - 1;
                    if (!Number.isInteger(index) || index < 0 || index >= MINES_TILES)
                        return sendBotMessage(channel.id, { content: `Pick a tile from 1 to ${MINES_TILES}.` });

                    if (game.revealed.has(index))
                        return sendBotMessage(channel.id, { content: "That tile is already revealed — pick another one." });

                    game.revealed.add(index);

                    if (game.mines.has(index)) {
                        minesGames.delete(channel.id);
                        return finish(channel.id, game.messageId, 0, minesText(game, `💥 **Boom — you hit a mine.** ${outcomeLine(0, game.bet)}`, true, index));
                    }

                    const multiplier = minesMultiplier(game.mines.size, game.revealed.size);
                    return edit(channel.id, game.messageId, minesText(game, game.opponentId
                        ? `Safe! Ask <@${game.opponentId}> for the next tile, then run \`/mines\` again — or cash out ${formatCoins(Math.floor(game.bet * multiplier))} with \`/mines action:cashout\`.`
                        : `Safe! Reveal another tile with \`/mines\`, or cash out ${formatCoins(Math.floor(game.bet * multiplier))} with \`/mines action:cashout\`.`));
                }

                if (game)
                    return sendBotMessage(channel.id, { content: "You already have a mines board in this channel — reveal a tile or cash out first." });

                const mines = Math.floor(Number(findOption<number>(args, "mines") ?? 3));
                if (!Number.isInteger(mines) || mines < 1 || mines > 24)
                    return sendBotMessage(channel.id, { content: "Pick between 1 and 24 mines." });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const newGame: MinesGame = { bet: betResult.bet, mines: placeMines(mines), revealed: new Set(), opponentId: findOption<string>(args, "opponent") };
                newGame.messageId = post(channel.id, minesText(newGame, newGame.opponentId
                    ? `<@${newGame.opponentId}> — pick a tile from 1 to ${MINES_TILES}. Then run \`/mines\` again with **tile** set to their pick.`
                    : "Run `/mines` again with a **tile** to reveal it — every safe tile raises the multiplier."));
                minesGames.set(channel.id, newGame);
            }
        },

        {
            name: "plinko",
            description: "Drop a ball through pegs and land in a multiplier slot",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                },
                {
                    name: "rows",
                    description: "How many peg rows the ball falls through (defaults to 8)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false,
                    choices: PLINKO_ROWS.map(rows => ({ name: `${rows} rows`, value: `${rows}`, label: `${rows} rows` }))
                }
            ],
            async execute(args, { channel }) {
                const rows = Number(findOption<number>(args, "rows") ?? 8);
                if (!PLINKO_ROWS.includes(rows))
                    return sendBotMessage(channel.id, { content: `Pick one of these row counts: ${PLINKO_ROWS.join(", ")}.` });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const drop = dropPlinko(rows);
                const payout = Math.floor(betResult.bet * drop.multiplier);
                const board = plinkoMultipliers(rows)
                    .map((multiplier, index) => index === drop.slot ? `**${multiplier}**` : `${multiplier}`)
                    .join(" · ");

                await finish(channel.id, undefined, payout, [
                    `🎯 **Plinko** — ${rows} rows`,
                    drop.path.map(side => side === "L" ? "⬅️" : "➡️").join(""),
                    `Landed in slot **${drop.slot + 1}** · **${formatMultiplier(drop.multiplier)}**`,
                    board,
                    "",
                    outcomeLine(payout, betResult.bet)
                ].join("\n"));
            }
        },

        {
            name: "dice",
            description: "Predict a dice roll, or whether it lands above or below a number",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                },
                {
                    name: "value",
                    description: "The number you're betting on",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: true
                },
                {
                    name: "mode",
                    description: "Exact roll, over the number or under it (defaults to exact)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Exact", value: "exact", label: "Exact" },
                        { name: "Over", value: "over", label: "Over" },
                        { name: "Under", value: "under", label: "Under" }
                    ]
                },
                {
                    name: "sides",
                    description: "How many sides the die has (defaults to 6)",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const mode = String(findOption<string>(args, "mode") ?? "exact").toLowerCase() as DiceMode;
                const sides = Math.floor(Number(findOption<number>(args, "sides") ?? 6));

                if (!Number.isInteger(sides) || sides < 2 || sides > 100)
                    return sendBotMessage(channel.id, { content: "Pick between 2 and 100 sides." });

                const value = Math.floor(Number(findOption<number>(args, "value")));
                if (!Number.isInteger(value) || value < 1 || value > sides)
                    return sendBotMessage(channel.id, { content: `Pick a value from 1 to ${sides}.` });

                const multiplier = diceMultiplier(mode, value, sides);
                if (multiplier == null)
                    return sendBotMessage(channel.id, { content: `For an **over** bet pick a value from 1 to ${sides - 1}, for an **under** bet pick 2 to ${sides}.` });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const roll = rollDice(sides);
                const won = diceWins(mode, value, roll);
                const payout = won ? Math.floor(betResult.bet * multiplier) : 0;

                await finish(channel.id, undefined, payout, [
                    `🎲 **Dice** — you rolled **${roll}** (d${sides})`,
                    `You bet **${formatCoins(betResult.bet)}** on **${mode} ${value}** (${formatMultiplier(multiplier)})`,
                    "",
                    outcomeLine(payout, betResult.bet)
                ].join("\n"));
            }
        },

        {
            name: "higherlower",
            description: "Guess whether the next card is higher or lower",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "guess",
                    description: "Higher or lower for the card that's showing — use the other player's call",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Higher", value: "higher", label: "Higher" },
                        { name: "Lower", value: "lower", label: "Lower" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person who calls higher or lower (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const guess = String(findOption<string>(args, "guess") ?? "").toLowerCase();
                const pending = higherLowerRounds.get(channel.id);

                if (guess !== "higher" && guess !== "lower") {
                    if (pending)
                        return sendBotMessage(channel.id, { content: "There's already a card waiting in this channel. Run `/higherlower` again with the **guess** option set." });

                    const betResult = await placeBet(findOption(args, "bet"));
                    if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                    const deck = createDeck();
                    const round: HigherLowerRound = { bet: betResult.bet, deck, card: draw(deck), opponentId: findOption<string>(args, "opponent") };
                    round.messageId = post(channel.id, higherLowerText(round, round.opponentId
                        ? `<@${round.opponentId}> — higher or lower? Then run \`/higherlower\` again with their guess. This message turns into the result.`
                        : "Run `/higherlower` again with **guess** set to `higher` or `lower`. This message turns into the result."));
                    higherLowerRounds.set(channel.id, round);
                    return;
                }

                let round = pending;
                if (!round) {
                    const betResult = await placeBet(findOption(args, "bet"));
                    if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                    const deck = createDeck();
                    round = { bet: betResult.bet, deck, card: draw(deck) };
                }

                higherLowerRounds.delete(channel.id);

                const next = draw(round.deck);
                const current = rankValue(round.card);
                const drawn = rankValue(next);
                const push = drawn === current;
                const won = guess === "higher" ? drawn > current : drawn < current;
                const payout = push ? round.bet : won ? round.bet * 2 : 0;

                await finish(channel.id, round.messageId, payout, [
                    "🃏 **Higher or Lower**",
                    `${formatCard(round.card)} → **${formatCard(next)}**`,
                    `You guessed **${guess}** · bet ${formatCoins(round.bet)}`,
                    "",
                    push ? `↔️ **Push** — same rank, your ${formatCoins(round.bet)} comes back` : outcomeLine(payout, round.bet)
                ].join("\n"));
            }
        },

        {
            name: "luck",
            description: "Non-violent elimination luck game — clear seats, dodge the dud, cash out",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "bet",
                    description: "How many coins to bet when starting a round",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "seat",
                    description: "The seat to clear, 1-6 — the one the other player picked",
                    type: ApplicationCommandOptionType.INTEGER,
                    required: false
                },
                {
                    name: "action",
                    description: "Cash out of the round that's already running",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                    choices: [
                        { name: "Cash out", value: "cashout", label: "Cash out" }
                    ]
                },
                {
                    name: "opponent",
                    description: "The person who calls the next move (optional)",
                    type: ApplicationCommandOptionType.USER,
                    required: false
                }
            ],
            async execute(args, { channel }) {
                const action = String(findOption<string>(args, "action") ?? "").toLowerCase();
                const game = luckGames.get(channel.id);

                if (action === "cashout") {
                    if (!game)
                        return sendBotMessage(channel.id, { content: "There's no lucky seats round in this channel. Start one with `/luck`." });

                    if (game.cleared.size === 0)
                        return sendBotMessage(channel.id, { content: "Clear at least one seat before cashing out." });

                    const multiplier = luckMultiplier(game.cleared.size);
                    const payout = Math.floor(game.bet * multiplier);
                    luckGames.delete(channel.id);

                    return finish(channel.id, game.messageId, payout, luckText(game, `💰 **Cashed out at ${formatMultiplier(multiplier)}** — ${outcomeLine(payout, game.bet)}`, true));
                }

                const seat = findOption<number>(args, "seat");

                if (seat != null) {
                    if (!game)
                        return sendBotMessage(channel.id, { content: "There's no lucky seats round in this channel. Start one with `/luck`." });

                    const index = Math.floor(Number(seat)) - 1;
                    if (!Number.isInteger(index) || index < 0 || index >= LUCK_SEATS)
                        return sendBotMessage(channel.id, { content: `Pick a seat from 1 to ${LUCK_SEATS}.` });

                    if (game.cleared.has(index))
                        return sendBotMessage(channel.id, { content: `Seat ${index + 1} is already cleared — pick another one.` });

                    if (index === game.dud) {
                        luckGames.delete(channel.id);
                        return finish(channel.id, game.messageId, 0, luckText(game, `💥 **That seat was the dud.** ${outcomeLine(0, game.bet)}`, true));
                    }

                    game.cleared.add(index);

                    const multiplier = luckMultiplier(game.cleared.size);
                    const payout = Math.floor(game.bet * multiplier);

                    if (game.cleared.size >= LUCK_SEATS - 1) {
                        luckGames.delete(channel.id);
                        return finish(channel.id, game.messageId, payout, luckText(game, `🎉 **Full clear!** ${outcomeLine(payout, game.bet)}`, true));
                    }

                    game.dud = rollDud(game.cleared);
                    return edit(channel.id, game.messageId, luckText(game, game.opponentId
                        ? `Safe! Ask <@${game.opponentId}> for the next seat, then run \`/luck\` again — or cash out ${formatCoins(payout)} with \`/luck action:cashout\`.`
                        : `Safe! Pick another seat with \`/luck\`, or cash out ${formatCoins(payout)} with \`/luck action:cashout\`.`));
                }

                if (game)
                    return sendBotMessage(channel.id, { content: "You already have a lucky seats round in this channel — pick a seat or cash out." });

                const betResult = await placeBet(findOption(args, "bet"));
                if ("error" in betResult) return sendBotMessage(channel.id, { content: betResult.error });

                const newGame: LuckGame = { bet: betResult.bet, cleared: new Set(), dud: rollDud(new Set()), opponentId: findOption<string>(args, "opponent") };
                newGame.messageId = post(channel.id, luckText(newGame, newGame.opponentId
                    ? `<@${newGame.opponentId}> — pick a seat from 1 to ${LUCK_SEATS}. Then run \`/luck\` again with **seat** set to their pick.`
                    : "Run `/luck` again with a **seat** to clear it — one seat is the dud, so cash out while you're ahead."));
                luckGames.set(channel.id, newGame);
            }
        },

        {
            name: "casino",
            description: "Show your virtual coin balance, or reset it",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "balance",
                    description: "Show your virtual coin balance",
                    type: ApplicationCommandOptionType.SUB_COMMAND
                },
                {
                    name: "reset",
                    description: `Reset your balance to ${formatCoins(STARTING_BALANCE)}`,
                    type: ApplicationCommandOptionType.SUB_COMMAND
                }
            ],
            async execute(args, { channel }) {
                if (args[0]?.name === "reset") {
                    const balance = await setBalance(STARTING_BALANCE);
                    return sendBotMessage(channel.id, { content: `Your balance has been reset to **${formatCoins(balance)}**.` });
                }

                const balance = await getBalance();
                return sendBotMessage(channel.id, {
                    content: `You have **${formatCoins(balance)}** in virtual coins.\nEverything here is played locally with fake coins — no real money, no bot involved.`
                });
            }
        }
    ]
});

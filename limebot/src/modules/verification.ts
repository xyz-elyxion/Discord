import { randomBytes } from "crypto";

import { ButtonStyles, Message } from "oceanic.js";

import { Vaius } from "~/Client";
import Config from "~/config";
import { db } from "~/db";

const { enabled, channelId, verifiedRoleId, siteUrl, clientId } = Config.verification;

const MARKER = "-# [verification card]";

// ---------------------------------------------------------------------------
// One-time verification tokens: the bot mints a token per user, the user
// opens https://<site>/verify?t=<token> (or the plugin fast-tracks it via
// OAuth), the site calls the bot's /v1/verify endpoints to validate, and on
// success the bot grants the verified role.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Built-in human challenge (no external captcha keys): every verification
// token gets a short multi-round challenge generated server-side. The website
// fetches the current question via GET /v1/verify/token/:t and submits
// answers via POST { answer }. Once all rounds are solved, the POST returns a
// one-time { proof } that must be sent back with { proof } to consume the
// token and grant the role. A minimum solve time defeats instant scripting.
// ---------------------------------------------------------------------------

const CHALLENGE_ROUNDS = 3;
const MIN_SOLVE_MS = 3000;

interface ChallengeRound { q: string; a: string[]; hint?: string; }
interface ChallengeState { rounds: ChallengeRound[]; round: number; createdAt: number; solved: boolean; }

const challenges = new Map<string, ChallengeState>();

const WORDS = ["lime", "lemon", "citrus", "discord", "verify", "human", "mod", "server"];
const ANIMALS = ["cat", "dog", "rabbit", "hamster", "parrot"];
const TOOLS = ["hammer", "screwdriver", "wrench", "pliers"];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function makeRound(): ChallengeRound {
    switch (Math.floor(Math.random() * 4)) {
        case 0: {
            const a = 2 + Math.floor(Math.random() * 20);
            const b = 2 + Math.floor(Math.random() * 20);
            const mul = Math.random() < 0.5;
            return mul
                ? { q: `What is ${a} × ${b}?`, a: [String(a * b)] }
                : { q: `What is ${a} + ${b}?`, a: [String(a + b)] };
        }
        case 1: {
            const w = pick(WORDS);
            return { q: `Type the word "${w}" backwards.`, a: [[...w].reverse().join("")] };
        }
        case 2: {
            const fruit = pick(ANIMALS);
            const decoy = pick(TOOLS);
            const options = [[fruit, decoy], [decoy, fruit]][Math.floor(Math.random() * 2)];
            return { q: `Which of these is an animal: "${options[0]}" or "${options[1]}"? (type the word)`, a: [fruit] };
        }
        default: {
            const w = pick(WORDS);
            const letter = w[Math.floor(Math.random() * w.length)];
            const n = [...w].filter(c => c === letter).length;
            return { q: `How many times does the letter "${letter}" appear in "${w}"?`, a: [String(n)] };
        }
    }
}

function normalize(s: string) {
    return String(s).trim().toLowerCase().replace(/\s+/g, "");
}

function getChallenge(token: string): ChallengeState {
    let st = challenges.get(token);
    if (!st) {
        st = { rounds: Array.from({ length: CHALLENGE_ROUNDS }, makeRound), round: 0, createdAt: Date.now(), solved: false };
        challenges.set(token, st);
        // opportunistic cleanup of stale challenges (10 min)
        if (challenges.size > 500)
            for (const [k, v] of challenges) if (Date.now() - v.createdAt > 10 * 60_000) challenges.delete(k);
    }
    return st;
}

export function currentChallenge(token: string) {
    const st = getChallenge(token);
    if (st.solved || !st.rounds[st.round]) return { round: CHALLENGE_ROUNDS, total: CHALLENGE_ROUNDS, question: null, solved: true };
    return { round: st.round + 1, total: CHALLENGE_ROUNDS, question: st.rounds[st.round].q, solved: false };
}

/** Returns { done, proof? } when solved, or the next question. */
export function submitAnswer(token: string, answer: string) {
    const st = getChallenge(token);
    const current = st.rounds[st.round];
    if (!current.a.some(a => normalize(a) === normalize(answer))) {
        // wrong answer: start over
        st.round = 0;
        st.createdAt = Date.now();
        return { done: false, restart: true, ...currentChallenge(token) };
    }
    st.round++;
    if (st.round < CHALLENGE_ROUNDS) return { done: false, restart: false, ...currentChallenge(token) };
    st.solved = true;
    return { done: true, restart: false, round: CHALLENGE_ROUNDS, total: CHALLENGE_ROUNDS, question: null, solved: true };
}

/** A token may only be consumed once its challenge has been fully solved,
 *  with a minimum elapsed time to defeat instant scripting. */
export function challengeSolved(token: string) {
    const st = challenges.get(token);
    return !!st && st.solved && Date.now() - st.createdAt >= MIN_SOLVE_MS;
}

export function clearChallenge(token: string) {
    challenges.delete(token);
}

export async function mintToken(userId: string) {
    const token = randomBytes(24).toString("base64url");
    await db.insertInto("verificationTokens")
        .values({ token, userId, used: 0, createdAt: new Date().toISOString() })
        .execute();
    return token;
}

export async function consumeToken(token: string) {
    const row = await db.selectFrom("verificationTokens")
        .where("token", "=", token)
        .where("used", "=", 0)
        .select("userId")
        .executeTakeFirst();
    if (!row) return null;

    await db.updateTable("verificationTokens")
        .set({ used: 1 })
        .where("token", "=", token)
        .execute();

    return row.userId;
}

export async function getTokenInfo(token: string) {
    return db.selectFrom("verificationTokens")
        .where("token", "=", token)
        .select(["userId", "used"])
        .executeTakeFirst();
}

export async function isVerified(userId: string) {
    const member = await Vaius.rest.guilds.getMember(Config.homeGuildId, userId).catch(() => null);
    return !!member?.roles.includes(verifiedRoleId);
}

export async function grantVerifiedRole(userId: string) {
    const guild = Vaius.guilds.get(Config.homeGuildId);
    if (!guild) throw new Error("home guild not cached");
    await guild.addMemberRole(userId, verifiedRoleId, "Website verification");
}

// ---------------------------------------------------------------------------
// Channel card: read-only channel with a single bot card. The card contains:
//   - a LINK button to the website verification page (works for everyone)
//   - a custom "Verify" button — clicking it mints a one-time token and
//     DMs the user a personalized link (mobile/non-plugin flow)
// The InteractiveVerification plugin replaces the channel content with a
// native in-client verification UI for Limey V1 users.
// ---------------------------------------------------------------------------

function buildVerificationMessage() {
    return {
        content: `${MARKER}\n# ✅ Verify to join the server\nWelcome to **Limey V1**! To unlock the server you need to verify that you're human.\n\n**Option 1 — Website:**\nClick **Verify on Website** below, log in with Discord, and you're in.\n\n**Option 2 — Limey V1 users:**\nIf you have the Limey V1 mod, click **Instant Verify** — no website needed. 🍋\n\n-# Verification proves you're human and agree to the rules in <#1553937108107006043>.`,
        components: [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: ButtonStyles.PRIMARY,
                        label: "Instant Verify",
                        customID: "verify:instant",
                        emoji: { name: "⚡" }
                    },
                    {
                        type: 2,
                        style: ButtonStyles.SECONDARY,
                        label: "Verify on Website",
                        customID: "verify:website",
                        emoji: { name: "🌐" }
                    }
                ]
            }
        ],
        allowedMentions: { everyone: false, roles: [], users: [] }
    };
}

async function ensureCard() {
    const messages = await Vaius.rest.channels.getMessages(channelId, { limit: 50 });
    const existing = messages.find(m => m.author.id === Vaius.user.id && m.content.includes(MARKER));
    if (existing && existing.id === messages[0].id) return;

    if (existing)
        await Vaius.rest.channels.deleteMessage(channelId, existing.id).catch(() => null);

    await Vaius.rest.channels.createMessage(channelId, buildVerificationMessage());
}

async function handleVerifyButton(interaction: import("oceanic.js").ComponentInteraction, instant: boolean) {
    // already verified? say so
    if (await isVerified(interaction.user.id)) {
        return void interaction.createMessage({
            content: "✅ You're already verified!",
            flags: 64
        });
    }

    const token = await mintToken(interaction.user.id);
    const url = `${siteUrl}/verify?t=${token}`;

    if (instant) {
        // Instant Verify (Limey V1 users): DM a one-time link, fall back to
        // an ephemeral message if DMs are blocked
        const dm = await interaction.user.createDM().catch(() => null);
        if (dm) {
            await dm.createMessage({
                content: `🍋 **Verify your Limey V1 account**\n\nClick this one-time link to verify — it expires after use:\n${url}`
            }).catch(() => null);
            return void interaction.createMessage({
                content: "⚡ I sent you a **one-time verification link** in your DMs — click it to finish verifying.",
                flags: 64
            });
        }

        return void interaction.createMessage({
            content: `⚡ Click this **one-time link** to verify:\n${url}\n-# This link works once and is only visible to you.`,
            flags: 64
        });
    }

    // Website verify: mint a fresh token and reply with the personalized
    // link directly (ephemeral — only visible to the clicker)
    return void interaction.createMessage({
        content: `🌐 **Here's your personal verification link:**\n${url}\n-# One-time use, only visible to you. Opens on limey-discord.onrender.com.`,
        flags: 64
    });
}

export function initVerification() {
    if (!enabled) {
        console.log("[verify] disabled");
        return;
    }

    // keep the channel read-only + the card fresh
    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.channelID !== channelId) return;
            if (msg.author.bot || msg.webhookID) return;

            await Vaius.rest.channels.editPermission(channelId, msg.guildID!, {
                type: 0,
                deny: String((1n << 11n) | (1n << 6n)), // SEND_MESSAGES | ADD_REACTIONS
                allow: "0"
            }).catch(e => console.error("[verify] failed to set read-only:", e));

            await Vaius.rest.channels.deleteMessage(channelId, msg.id, "Verification channel is read-only").catch(() => null);

            await ensureCard();
        } catch (e) {
            console.error("[verify] error:", e);
        }
    });

    // Verify buttons (Instant Verify + Verify on Website)
    Vaius.on("interactionCreate", async interaction => {
        try {
            if (interaction.type !== 3 /* COMPONENT */) return;
            const data = (interaction as import("oceanic.js").ComponentInteraction).data;
            if (data.customID === "verify:instant")
                await handleVerifyButton(interaction as import("oceanic.js").ComponentInteraction, true);
            else if (data.customID === "verify:website")
                await handleVerifyButton(interaction as import("oceanic.js").ComponentInteraction, false);
        } catch (e) {
            console.error("[verify] interaction error:", e);
        }
    });

    console.log("[verify] verification module initialized");
}

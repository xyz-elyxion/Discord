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

function buildVerificationMessage(verifyButton = true) {
    return {
        content: `${MARKER}\n# ✅ Verify to join the server\nWelcome to **Limey V1**! To unlock the server you need to verify that you're human.\n\n**Option 1 — Website:**\nClick **Verify on Website** below, log in with Discord, and you're in.\n\n**Option 2 — Limey V1 users:**\nIf you have the Limey V1 mod, click **Instant Verify** — no website needed. 🍋\n\n-# Verification proves you're human and agree to the rules in <#1553937108107006043>.`,
        components: [
            {
                type: 1,
                components: [
                    ...(verifyButton ? [{
                        type: 2,
                        style: ButtonStyles.PRIMARY,
                        label: "Instant Verify",
                        customID: "verify:instant",
                        emoji: { name: "⚡" }
                    }] : []),
                    {
                        type: 2,
                        style: ButtonStyles.LINK,
                        label: "Verify on Website",
                        url: `${siteUrl}/verify`,
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

async function handleInstantVerify(interaction: import("oceanic.js").ComponentInteraction) {
    // already verified? say so
    if (await isVerified(interaction.user.id)) {
        return void interaction.createMessage({
            content: "✅ You're already verified!",
            flags: 64
        });
    }

    const token = await mintToken(interaction.user.id);
    const url = `${siteUrl}/verify?t=${token}`;

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

    // DMs blocked — fall back to ephemeral link
    return void interaction.createMessage({
        content: `⚡ Click this **one-time link** to verify:\n${url}\n-# This link works once and is only visible to you.`,
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

    // Instant Verify button
    Vaius.on("interactionCreate", async interaction => {
        try {
            if (interaction.type !== 3 /* COMPONENT */) return;
            const data = (interaction as import("oceanic.js").ComponentInteraction).data;
            if (data.customID !== "verify:instant") return;
            await handleInstantVerify(interaction as import("oceanic.js").ComponentInteraction);
        } catch (e) {
            console.error("[verify] interaction error:", e);
        }
    });

    console.log("[verify] verification module initialized");
}

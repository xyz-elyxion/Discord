import { ButtonStyles, Message } from "oceanic.js";

import { Vaius } from "~/Client";

import { getGuildConfig } from "./verification";

// Home-guild fallbacks (kept for backwards compatibility)
const HOME_RULES_CHANNEL_ID = "1553937108107006043";
const HOME_RULES_PAGE_URL = "https://limey-discord.onrender.com/rules.html";

const MARKER = "-# [rules page card]";
const MAX_RULES_LENGTH = 1900;

// Short rule summaries — the full page lives on the website (home guild)
const RULES_SUMMARY = [
    ["1.", "Respect & Professional Conduct", "No harassment, discrimination, or hostile behaviour. Disagreements are fine — kept respectful."],
    ["2.", "Community Integrity", "No misinformation, impersonation, deception, or drama."],
    ["3.", "Security & Safety", "No malware, token grabbers, scam links, or credential requests. Report security issues to staff privately."],
    ["4.", "Plugins & Development", "No abusive, malicious, or ToS-violating projects. No hidden tracking. Credit and license your work."],
    ["5.", "Content", "No NSFW, gore, illegal content, hate speech, or excessive profanity."],
    ["6.", "Advertising", "No unsolicited ads or server invites without permission. Partnerships need staff approval."],
    ["7.", "Channel Usage", "Use channels for their intended purpose and keep discussions relevant."],
    ["8.", "Support", "Describe the issue, include errors/logs and reproduction steps. Be patient — helpers are volunteers."],
    ["9.", "Bug Reports", "Check for duplicates, be accurate, never submit false reports."],
    ["10.", "Privacy", "Never share others' personal info, private conversations, or credentials."],
    ["11.", "Moderation", "Staff may warn, mute, kick, or ban based on context, severity, and history. Appeal privately via modmail."],
    ["12.", "Discord ToS", "Follow Discord's Terms of Service and Community Guidelines at all times."],
] as const;

function buildHomeRulesMessage() {
    const ruleLines = RULES_SUMMARY
        .map(([num, title, desc]) => `**${num} ${title}** — ${desc}`)
        .join("\n");

    return {
        content: `${MARKER}\n# 📜 Official Community Guidelines\nWelcome to **Limey V1** — a professional and welcoming environment for users, developers, contributors, and enthusiasts.\n\nBy participating in this community you agree to these guidelines. Violations may result in moderation action.\n\n${ruleLines}\n\n-# Read the full, formatted rules on our website ↓`,
        components: [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: ButtonStyles.LINK,
                        label: "Read the Full Rules",
                        url: HOME_RULES_PAGE_URL,
                        emoji: { name: "📜" }
                    }
                ]
            }
        ],
        allowedMentions: { everyone: false, roles: [], users: [] }
    };
}

function buildCustomRulesMessage(text: string) {
    return {
        content: `${MARKER}\n# 📜 Server Rules\n${text.slice(0, MAX_RULES_LENGTH)}`,
        allowedMentions: { everyone: false, roles: [], users: [] }
    };
}

/** Post or refresh the rules card in a guild's rules channel. */
export async function ensureRulesCard(guildId: string, rulesChannelId: string) {
    const messages = await Vaius.rest.channels.getMessages(rulesChannelId, { limit: 50 });
    const existing = messages.find(m => m.author.id === Vaius.user.id && m.content.includes(MARKER));
    if (existing && existing.id === messages[0].id) return;

    if (existing)
        await Vaius.rest.channels.deleteMessage(rulesChannelId, existing.id).catch(() => null);

    const custom = getGuildConfig(guildId)?.rulesText;
    const message = custom ? buildCustomRulesMessage(custom) : buildHomeRulesMessage();
    await Vaius.rest.channels.createMessage(rulesChannelId, message);
}

/** Keep a rules channel read-only so it behaves like a static page. */
export async function lockRulesChannel(rulesChannelId: string, guildId: string) {
    await Vaius.rest.channels.editPermission(rulesChannelId, guildId, {
        type: 0, // role overwrite for @everyone
        deny: String((1n << 11n) | (1n << 6n)), // SEND_MESSAGES | ADD_REACTIONS
        allow: "0"
    }).catch(e => console.error("[rules] failed to set channel read-only:", e));
}

/**
 * Keeps every configured guild's rules channel pinned to a single bot card:
 * the home guild gets its default summary card, other guilds get their
 * dashboard-authored rules text. Channels are kept read-only.
 */
export function initRulesPage() {
    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot || msg.webhookID) return;

            // resolve which guild (if any) treats this channel as its rules page
            let guildId: string | null = null;
            let rulesChannelId: string | null = null;
            if (msg.channelID === HOME_RULES_CHANNEL_ID) {
                guildId = "home";
                rulesChannelId = HOME_RULES_CHANNEL_ID;
            } else {
                for (const cfg of [...Vaius.guilds.values()]) {
                    const gcfg = getGuildConfig(cfg.id);
                    if (gcfg?.rulesChannelId && gcfg.rulesText && gcfg.rulesChannelId === msg.channelID) {
                        guildId = cfg.id;
                        rulesChannelId = msg.channelID;
                        break;
                    }
                }
            }
            if (!guildId || !rulesChannelId) return;

            await lockRulesChannel(rulesChannelId, msg.guildID!);
            await Vaius.rest.channels.deleteMessage(rulesChannelId, msg.id, "Rules channel is read-only").catch(() => null);
            await ensureRulesCard(guildId, rulesChannelId);
        } catch (e) {
            console.error("[rules] error:", e);
        }
    });

    console.log("[rules] rules page module initialized");
}

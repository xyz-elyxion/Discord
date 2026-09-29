import { ButtonStyles, Message } from "oceanic.js";

import { Vaius } from "~/Client";

// Channel that acts as the "rules page"
const RULES_CHANNEL_ID = "1553937108107006043";
const RULES_PAGE_URL = "https://limey-discord.onrender.com/rules.html";

const MARKER = "-# [rules page card]";

// Short rule summaries — the full page lives on the website
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

function buildRulesMessage() {
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
                        url: RULES_PAGE_URL,
                        emoji: { name: "📜" }
                    }
                ]
            }
        ],
        allowedMentions: { everyone: false, roles: [], users: [] }
    };
}

/**
 * Keeps the rules channel pinned to a single bot card that summarizes the
 * community rules with a link button to the full rules page. The channel
 * itself is kept read-only for @everyone so it behaves like a static page.
 */
export function initRulesPage() {
    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (msg.author.bot || msg.webhookID) return;
            if (msg.channelID !== RULES_CHANNEL_ID) return;
            if (!msg.inCachedGuildChannel()) return;

            // Keep the channel read-only so it behaves like a static rules page
            await Vaius.rest.channels.editPermission(RULES_CHANNEL_ID, msg.guildID, {
                type: 0, // role overwrite for @everyone
                deny: String((1n << 11n) | (1n << 6n)), // SEND_MESSAGES | ADD_REACTIONS
                allow: "0"
            }).catch(e => console.error("[rules] failed to set channel read-only:", e));

            // remove any user messages that slipped in
            await Vaius.rest.channels.deleteMessage(RULES_CHANNEL_ID, msg.id, "Rules channel is read-only").catch(() => null);

            // keep our rules card as the only/latest bot message
            const messages = await Vaius.rest.channels.getMessages(RULES_CHANNEL_ID, { limit: 50 });
            const existing = messages.find(m => m.author.id === Vaius.user.id && m.content.includes(MARKER));
            if (existing && existing.id === messages[0].id) return;

            if (existing)
                await Vaius.rest.channels.deleteMessage(RULES_CHANNEL_ID, existing.id).catch(() => null);

            await Vaius.rest.channels.createMessage(RULES_CHANNEL_ID, buildRulesMessage());
        } catch (e) {
            console.error("[rules] error:", e);
        }
    });

    console.log("[rules] rules page module initialized");
}

import { Message } from "oceanic.js";

import { Vaius } from "~/Client";

import { getGuildConfig } from "./verification";

const MARKER = "-# [rules page card]";
const MAX_RULES_LENGTH = 1900;

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
    if (!custom) throw new Error("no rules text configured for this guild");
    await Vaius.rest.channels.createMessage(rulesChannelId, buildCustomRulesMessage(custom));
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

            // find the guild whose rules channel this is
            let guildId: string | null = null;
            let rulesChannelId: string | null = null;
            for (const cfg of [...Vaius.guilds.values()]) {
                const gcfg = getGuildConfig(cfg.id);
                if (gcfg?.rulesChannelId && gcfg.rulesText && gcfg.rulesChannelId === msg.channelID) {
                    guildId = cfg.id;
                    rulesChannelId = msg.channelID;
                    break;
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

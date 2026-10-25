import { ChannelTypes, Member, Message } from "oceanic.js";

import { Vaius } from "~/Client";
import Config from "~/config";
import { db } from "~/db";
import { silently } from "~/util/functions";
import { logAutoModAction } from "~/util/logAction";
import { addWarning } from "~/commands/moderation/warn";

// ---- Settings ---------------------------------------------------------------

const INVITE_REGEX = /discord(?:app)?\.(?:gg|com\/invite|io)\/[\w-]+/i;

// urls that are always allowed
const URL_ALLOWLIST = [
    "github.com", "githubusercontent.com", "discord.com", "discord.gg",
    "limey-discord.onrender.com", "youtube.com", "youtu.be", "spotify.com",
    "npmjs.com", "stackoverflow.com", "reddit.com", "imgur.com",
];

// channels where automod is more lenient (bot spam, support, etc.)
const EXEMPT_CHANNEL_IDS: string[] = [
    // filled from config below
];

const MENTION_LIMIT = 5; // more than this many unique mentions in one message
const CAPS_RATIO = 0.75; // more than 75% uppercase letters...
const CAPS_MIN_LENGTH = 24; // ...in messages of at least this many letters

// ---- Escalation -------------------------------------------------------------

type Escalation = "delete" | "warn" | "mute";

const recentPunishments = new Map<string, number[]>(); // userId -> timestamps

function recordPunishment(userId: string) {
    const now = Date.now();
    const list = (recentPunishments.get(userId) ?? []).filter(t => now - t < 10 * 60_000);
    list.push(now);
    recentPunishments.set(userId, list);
    return list.length;
}

/**
 * Escalation ladder per 10-minute window:
 *  1st-2nd hit: delete + warn
 *  3rd+ hit:    delete + 1h mute
 */
async function punish(msg: Message, member: Member, reason: string, severity: "light" | "hard" = "light") {
    const count = recordPunishment(member.id);

    await silently(msg.channel?.deleteMessage?.(msg.id, `AutoMod: ${reason}`).catch(() => null));

    const isMute = severity === "hard" || count >= 3;

    if (isMute) {
        const until = new Date(Date.now() + 60 * 60_000);
        await silently(member.edit({
            communicationDisabledUntil: until.toISOString(),
            reason: `AutoMod: ${reason} (repeat offender)`
        }).catch(e => console.error("[automod] mute failed:", e)));
        await silently(member.user.createDM().then(dm => dm.createMessage({
            content: `You were automatically muted on the Limey V1 Server for 1 hour.\n## Reason:\n${reason}`
        })).catch(() => null));
        logAutoModAction(`**Muted** <@${member.id}> for 1h — ${reason} (strike ${count})`);
    } else {
        await silently(addWarning(msg.guildID ?? msg.guild?.id ?? "", member.id, Vaius.user.id, `AutoMod: ${reason}`));
        await silently(member.user.createDM().then(dm => dm.createMessage({
            content: `You were automatically warned on the Limey V1 Server.\n## Reason:\n${reason}\n\nRepeated violations will result in a mute.`
        })).catch(() => null));
        logAutoModAction(`**Warned** <@${member.id}> — ${reason} (strike ${count})`);
    }
}

// ---- Checks -----------------------------------------------------------------

function isStaffMember(member: Member | undefined) {
    if (!member) return true; // can't check (webhooks etc.) — don't touch
    if (member.guild.ownerID === member.id) return true;
    return member.roles.some(r => Config.roles.staffRoles.includes(r));
}

function isExemptChannel(channelId: string) {
    return EXEMPT_CHANNEL_IDS.includes(channelId);
}

function checkMentions(msg: Message) {
    const uniqueMentions = new Set(msg.mentions?.map(u => u.id) ?? []);
    // @everyone/@here count too
    if (msg.mentionEveryone) uniqueMentions.add("everyone");
    return uniqueMentions.size > MENTION_LIMIT;
}

function checkCaps(msg: Message) {
    const content = msg.content;
    if (content.length < CAPS_MIN_LENGTH) return false;
    const letters = content.replace(/[^a-zA-Z]/g, "");
    if (letters.length < CAPS_MIN_LENGTH) return false;
    const upper = letters.replace(/[^A-Z]/g, "").length;
    return upper / letters.length >= CAPS_RATIO;
}

function checkInvite(msg: Message) {
    if (!INVITE_REGEX.test(msg.content)) return false;
    // allow invites that come from whitelisted urls' context? no — invites are invites.
    return true;
}

function checkMaliciousLink(msg: Message) {
    const urls = msg.content.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
    return urls.some(url => {
        try {
            const host = new URL(url).hostname.replace(/^www\./, "");
            if (URL_ALLOWLIST.some(a => host === a || host.endsWith("." + a))) return false;
            // known sketchy url shorteners / file hosts commonly used for malware
            return /(\.ru|\.tk|shorte\.st|adf\.ly|bit\.ly\/[a-z0-9]{4}$|s\.undfe\.com|mediafire\.com\/(file|download)\/(?!.*key))/i.test(url);
        } catch {
            return false;
        }
    });
}

// ---- Hook -------------------------------------------------------------------

export function initAutoMod() {
    Vaius.on("messageCreate", async (msg: Message) => {
        try {
            if (!msg.inCachedGuildChannel()) return;
            if (msg.author.bot || msg.webhookID) return;
            if (msg.guild?.id !== Config.homeGuildId) return;

            const member = msg.member;
            if (!member || isStaffMember(member)) return;
            if (isExemptChannel(msg.channelID)) return;

            // moderation-ish channels: ignore in support channels entirely for links
            const isForumPostStarter = msg.channel.type === ChannelTypes.PUBLIC_THREAD && !msg.content;

            if (isForumPostStarter) return;

            if (checkMaliciousLink(msg)) {
                return punish(msg, member, "Posting a malicious or suspicious link", "hard");
            }

            if (checkInvite(msg)) {
                return punish(msg, member, "Posting server invite links");
            }

            if (checkMentions(msg)) {
                return punish(msg, member, "Mass mentioning users (ping spam)");
            }

            if (checkCaps(msg)) {
                return punish(msg, member, "Excessive use of capital letters");
            }
        } catch (e) {
            console.error("[automod] error:", e);
        }
    });

    console.log("[automod] initialized");
}

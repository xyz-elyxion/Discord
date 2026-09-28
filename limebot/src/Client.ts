import { AnyTextableChannel, Client, Message } from "oceanic.js";
import { ProxyAgent } from "undici";

import { handleError } from ".";
import { CommandContext, Commands } from "./Commands";
import Config from "./config";
import { Emoji, Millis } from "./constants";
import { BotState } from "./db/botState";
import { emojiCacheReady, ensureEmojis, getEmojiForReaction } from "./modules/emojiManager";
import { moderateMessage } from "./modules/moderation";
import { lobotomiseMaybe } from "./modules/moderation/lobotomy";
import { Deduper } from "./util/Deduper";
import { reply } from "./util/discord";
import { silently } from "./util/functions";

// Optional proxy for Discord REST traffic — set by server.js from the
// admin-managed proxy pool (LIMEBOT_PROXY for one, LIMEBOT_PROXIES_JSON for
// several; one is picked at random per process start). Gateway WS traffic is
// not proxied — only REST, which is what gets IP rate limited.
const PROXY_URLS: string[] = (() => {
    try {
        if (process.env.LIMEBOT_PROXIES_JSON) {
            const parsed = JSON.parse(process.env.LIMEBOT_PROXIES_JSON);
            if (Array.isArray(parsed)) return parsed.filter(x => typeof x === "string" && x);
        }
    } catch (err: any) {
        console.error("[proxy] failed to parse LIMEBOT_PROXIES_JSON:", err?.message);
    }
    return process.env.LIMEBOT_PROXY ? [process.env.LIMEBOT_PROXY] : [];
})();
const proxyUrl = PROXY_URLS.length
    ? PROXY_URLS[Math.floor(Math.random() * PROXY_URLS.length)]
    : undefined;

export const Vaius = new Client({
    auth: "Bot " + Config.token,
    gateway: {
        intents: process.env.LIMEY_BOT_MESSAGE_CONTENT === "1"
            ? ["ALL_NON_PRIVILEGED", "MESSAGE_CONTENT", "GUILD_MEMBERS"]
            : ["ALL_NON_PRIVILEGED", "GUILD_MEMBERS"]
    },
    rest: proxyUrl ? { agent: new ProxyAgent(proxyUrl) as Client["rest"]["options"]["agent"] } : {},
    allowedMentions: {
        everyone: false,
        repliedUser: false,
        roles: false,
        users: false
    }
});

if (proxyUrl) {
    const host = (() => { try { return new URL(proxyUrl).host; } catch { return "?"; } })();
    console.log(`[proxy] routing Discord REST through proxy (${PROXY_URLS.length} in pool): ${host}`);
}

export let OwnerId: string;
Vaius.once("ready", async () => {
    ensureEmojis();

    Vaius.rest.oauth.getApplication().then(app => {
        OwnerId = app.ownerID;
    });

    console.log("hi");
    console.log(`Connected as ${Vaius.user.tag} (${Vaius.user.id})`);
    console.log(`I am in ${Vaius.guilds.size} guilds`);
    console.log(`https://discord.com/oauth2/authorize?client_id=${Vaius.user.id}&permissions=8&scope=bot+applications.commands`);

    if (BotState.restartData) {
        const { channelId, messageId } = BotState.restartData;
        delete BotState.restartData;

        await Vaius.rest.channels.editMessage(channelId, messageId, { content: "hiiii :3" })
            .catch(() => Vaius.rest.channels.createMessage(channelId, { content: "hiiii :3" }));
    }
});

const whitespaceRe = /\s+/;
const GEN_AI_ID = "974297735559806986";

Vaius.on("messageCreate", msg => handleMessage(msg, false));
Vaius.on("messageUpdate", (msg, oldMsg) => {
    if (oldMsg && msg.content === oldMsg.content) return;
    if (!msg.editedTimestamp) return;

    // Ignore old updates - If a very old message is loaded by a user, discord may rebuild its embeds
    // and dispatch a message update
    if (msg.editedTimestamp.getTime() < Date.now() - 5 * Millis.MINUTE) return;

    handleMessage(msg, true);
});

const IntroRegex = /^(?:hi|hello|hey|sup|yo)? ?(?:i['’ʼʹ´]?m|i am) (.{1,32}?)$/i;
const IntroCooldown = new Deduper(30 * Millis.MINUTE);
async function handleIntroduction(msg: Message) {
    if (!msg.inCachedGuildChannel() || msg.channel.parentID === "1553922850669334600" /* support */) return;

    if (msg.content && Math.random() > 0.9 && IntroRegex.test(msg.content) && !IntroCooldown.getOrAdd(msg.author.id)) {
        const [, name] = msg.content.match(IntroRegex)!;
        if (await silently(msg.member.edit({ nick: name }))) {
            reply(msg, { content: `Hi ${name}!` });
        }
    }
}

async function handleMessage(msg: Message, isEdit: boolean) {
    if (msg.inCachedGuildChannel() && await lobotomiseMaybe(msg)) return;
    if (msg.author.bot && msg.author.id !== GEN_AI_ID) return;

    moderateMessage(msg, isEdit);
    handleIntroduction(msg);

    await emojiCacheReady;

    const lowerContent = msg.content.toLowerCase();

    const prefix = Config.prefixes.find(p => lowerContent.startsWith(p));
    if (!prefix) return;

    const content = msg.content.slice(prefix.length).trim();
    const args = content.split(whitespaceRe);

    const cmdName = args.shift()?.toLowerCase()!;
    const cmd = Commands[cmdName];
    if (!cmd) return;

    if (cmd.ownerOnly && msg.author.id !== OwnerId)
        return;

    if (cmd.guildOnly && msg.inDirectMessageChannel())
        return reply(msg, { content: "This command can only be used in servers" });

    if (cmd.permissions) {
        if (!msg.inCachedGuildChannel()) return;

        const memberPerms = msg.channel.permissionsOf(msg.member);
        if (cmd.permissions.some(perm => !memberPerms.has(perm)))
            return;
    }

    if (cmd.allowedRoles) {
        if (!msg.inCachedGuildChannel()) return;

        if (!cmd.allowedRoles.some(role => msg.member.roles.includes(role)))
            return silently(msg.createReaction(Emoji.Anger));
    }

    const noRateLimit = msg.member?.permissions.has("MANAGE_MESSAGES");

    if (!noRateLimit && cmd.rateLimits.getOrAdd(msg.author.id)) {
        silently(msg.createReaction("🛑"));
        silently(msg.createReaction(getEmojiForReaction("snailcat")));
        return;
    }

    if (!msg.channel)
        await msg.client.rest.channels.get(msg.channelID);

    const context = new CommandContext(
        msg as Message<AnyTextableChannel>,
        prefix,
        cmdName
    );

    try {
        if (cmd.rawContent)
            await cmd.execute(context, content.slice(cmdName.length).trim());
        else
            await cmd.execute(context, ...args);
    } catch (e) {
        handleError(`Failed to run ${cmd.name}`, e);
        silently(reply(msg, { content: "oop, that didn't go well 💥" }));
    }
}

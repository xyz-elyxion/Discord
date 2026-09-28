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

// Optional proxy pool for Discord REST traffic, managed via the admin API.
// The bot receives the pool at startup (LIMEBOT_PROXY / LIMEBOT_PROXIES_JSON)
// and can also hot-swap proxies at runtime by polling the server's admin API
// (LIMEBOT_ADMIN_TOKEN) — no restart needed. One proxy is picked at random and
// swapped every POLL_MS. Gateway WS traffic is not proxied — only REST, which
// is what gets IP rate limited.
const POLL_MS = 5 * Millis.MINUTE;
let proxyUrls: string[] = (() => {
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
let currentProxy: ProxyAgent | undefined;

function pickProxy(): string | undefined {
    return proxyUrls.length ? proxyUrls[Math.floor(Math.random() * proxyUrls.length)] : undefined;
}

function setProxy(url?: string) {
    if (currentProxy) currentProxy.close().catch(() => {});
    currentProxy = url ? new ProxyAgent(url) : undefined;
    // Oceanic reads rest.options.agent on every request, so swapping it here
    // takes effect immediately — no client restart needed.
    (Vaius.rest.options as { agent?: unknown }).agent = currentProxy ?? null;
    if (url) {
        const host = (() => { try { return new URL(url).host; } catch { return "?"; } })();
        console.log(`[proxy] routing Discord REST through ${host} (${proxyUrls.length} in pool)`);
    } else {
        console.log("[proxy] pool empty — Discord REST traffic now direct");
    }
}

export const Vaius = new Client({
    auth: "Bot " + Config.token,
    gateway: {
        intents: process.env.LIMEY_BOT_MESSAGE_CONTENT === "1"
            ? ["ALL_NON_PRIVILEGED", "MESSAGE_CONTENT", "GUILD_MEMBERS"]
            : ["ALL_NON_PRIVILEGED", "GUILD_MEMBERS"]
    },
    rest: {},
    allowedMentions: {
        everyone: false,
        repliedUser: false,
        roles: false,
        users: false
    }
});

if (proxyUrls.length) setProxy(pickProxy());

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

// Hot-swap the proxy pool at runtime: fetch the current enabled pool from the
// server's admin API every POLL_MS and apply it if it changed.
async function refreshProxyPool() {
    const adminToken = process.env.LIMEBOT_ADMIN_TOKEN;
    if (!adminToken) return;

    try {
        const res = await fetch(`${Config.limeyApiBase}/v1/admin/proxies`, {
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(15_000)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const urls: string[] = (data.proxies || [])
            .filter((p: any) => p.enabled !== false)
            .map((p: any) => p.url)
            .filter(Boolean);

        const changed = urls.length !== proxyUrls.length || urls.some((u, i) => u !== proxyUrls[i]);
        if (changed) {
            proxyUrls = urls;
            setProxy(pickProxy());
        }
    } catch (err: any) {
        console.error("[proxy] failed to refresh pool:", err?.message);
    }
}

if (process.env.LIMEBOT_ADMIN_TOKEN) {
    setInterval(refreshProxyPool, POLL_MS);
    void refreshProxyPool();
}

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

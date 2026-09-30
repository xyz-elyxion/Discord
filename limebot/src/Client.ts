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

// Single proxy for Discord REST traffic, set via LIMEBOT_PROXY by the server.
// Oceanic reads rest.options.agent on every request, so the proxy can be
// swapped at runtime if it dies. Gateway WS traffic is not proxied.
let proxyAgent: ProxyAgent | undefined;

export function getProxyUrl(): string | undefined {
    return process.env.LIMEBOT_PROXY || undefined;
}

export function applyProxy(url?: string) {
    const proxyUrl = url ?? getProxyUrl();
    if (proxyAgent) {
        void proxyAgent.close().catch(() => {});
        proxyAgent = undefined;
    }
    (Vaius.rest.options as { agent?: unknown }).agent = null;
    if (!proxyUrl) {
        console.log("[proxy] no proxy configured — Discord REST traffic is direct");
        return false;
    }
    try {
        proxyAgent = new ProxyAgent(proxyUrl);
        (Vaius.rest.options as { agent?: unknown }).agent = proxyAgent;
        const host = (() => { try { return new URL(proxyUrl).host; } catch { return "?"; } })();
        console.log(`[proxy] Discord REST traffic routed through ${host}`);
        return true;
    } catch (err: any) {
        console.error("[proxy] failed to create proxy agent:", err?.message);
        return false;
    }
}

/**
 * Test a proxy by GETting Discord's REST root through it.
 * Returns latency in ms, or throws.
 */
export async function testProxy(proxyUrl: string): Promise<number> {
    const started = Date.now();
    const agent = new ProxyAgent(proxyUrl);
    try {
        const res = await fetch("https://discord.com/api/v10/gateway", {
            dispatcher: agent,
            signal: AbortSignal.timeout(10_000)
        } as any);
        if (!res.ok) throw new Error(`HTTP ${res.status} via proxy`);
        return Date.now() - started;
    } finally {
        void agent.close().catch(() => {});
    }
}

export const Vaius = new Client({
    auth: "Bot " + Config.token,
    gateway: {
        intents: process.env.LIMEY_BOT_MESSAGE_CONTENT === "1"
            ? ["ALL_NON_PRIVILEGED", "MESSAGE_CONTENT", "GUILD_MEMBERS"]
            : ["ALL_NON_PRIVILEGED", "GUILD_MEMBERS"]
    },
    // Default is 15s, which is too tight when REST traffic goes through a
    // proxy (observed ~10s round trips).
    rest: { requestTimeout: 45_000 },
    allowedMentions: {
        everyone: false,
        repliedUser: false,
        roles: false,
        users: false
    }
});

applyProxy();

// We intentionally register many messageCreate listeners across modules;
// raise the limit so Node doesn't warn about a possible leak.
Vaius.setMaxListeners(50);

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

// Prefix commands were removed — everything is slash-only now (see SlashCommands.ts).
async function handleMessage(msg: Message, isEdit: boolean) {
    if (msg.inCachedGuildChannel() && await lobotomiseMaybe(msg)) return;
    if (msg.author.bot && msg.author.id !== GEN_AI_ID) return;

    moderateMessage(msg, isEdit);
    handleIntroduction(msg);
}

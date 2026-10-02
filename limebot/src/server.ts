import Fastify from "fastify";

import { readFile } from "fs/promises";
import Config from "./config";
import { PROD } from "./constants";
import { getGitRemote } from "./util/git";
import { makeLazy } from "./util/lazy";
import { challengeSolved, clearChallenge, consumeToken, currentChallenge, disableGuildConfig, ensureCard, getGuildConfig, getGuildConfigIds, getGuildRulesText, getTokenInfo, grantVerifiedRole, isVerified, mintToken, setGuildConfig, setGuildRulesText, submitAnswer } from "./modules/verification";
import { ensureRulesCard, lockRulesChannel } from "./modules/rulesPage";
import { disableCountingConfig, getCountingConfig, setCountingConfig } from "./modules/counting";
import { disableLevelingConfig, getLeaderboard, getLevelingConfig, setLevelingConfig } from "./modules/leveling";
import { disableWelcomerConfig, getWelcomerConfig, setWelcomerConfig } from "./modules/welcomer";
import { Vaius } from "./Client";
import { getVisibleChannels, isChannelObfuscated } from "./util/obfuscation";

const { enabled, port } = Config.httpServer;

export const fastify = Fastify({
    logger: !PROD && {
        transport: {
            target: "pino-pretty",
        }
    }
});

const getIndex = makeLazy(async () => {
    const contents = await readFile("assets/index.html", "utf-8");
    const remote = await getGitRemote();

    return contents.replace("%GIT_SOURCE_URL%", remote);
});

if (enabled) {
    fastify.get("/", async (req, res) => {
        res
            .type("text/html")
            .send(await getIndex());


    });

    // ------------------------------------------------------------------
    // Verification API (used by public/verify.html and the
    // InteractiveVerification plugin)
    // ------------------------------------------------------------------
    const verifyCors = (req: any, res: any) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type");
    };

    fastify.options("/v1/verify/*", async (req, res) => {
        verifyCors(req, res);
        return res.code(204).send();
    });

    // resolve the target guild for verification: an explicit, configured
    // guildId wins; otherwise fall back to the single configured guild
    const resolveGuild = (guildId: string | undefined | null) => {
        if (guildId && /^\d{17,20}$/.test(guildId) && getGuildConfig(guildId)) return guildId;
        const ids = getGuildConfigIds();
        return ids.length === 1 ? ids[0] : null;
    };

    // token status + current challenge question — used by the website page
    fastify.get("/v1/verify/token/:token", async (req, res) => {
        verifyCors(req, res);
        const { token } = req.params as { token: string };
        const info = await getTokenInfo(token);
        if (!info) return res.code(404).send({ error: "invalid token" });
        return { userId: info.userId, used: !!info.used, challenge: currentChallenge(token) };
    });

    // submit a challenge answer or the final proof, then consume token → grant role
    fastify.post("/v1/verify/token/:token", async (req, res) => {
        verifyCors(req, res);
        const { token } = req.params as { token: string };
        const body = (req.body ?? {}) as { answer?: string; proof?: string };

        const info = await getTokenInfo(token);
        if (!info) return res.code(404).send({ error: "invalid token" });
        if (info.used) return res.code(410).send({ error: "token already used or invalid" });

        // step 1..N: answering challenge rounds
        if (typeof body.answer === "string" && !body.proof) {
            const result = submitAnswer(token, body.answer);
            if (!result.done)
                return { ok: false, restart: result.restart, challenge: { round: result.round, total: result.total, question: result.question } };
            return { ok: true, solved: true };
        }

        // final step: consume token and grant role (requires the challenge to
        // have been solved; proof = the token itself, only sent after solving)
        if (typeof body.proof === "string" && body.proof === token) {
            if (!challengeSolved(token))
                return res.code(403).send({ error: "challenge not solved — answer the questions first" });
            clearChallenge(token);
            const consumed = await consumeToken(token);
            if (!consumed) return res.code(410).send({ error: "token already used or invalid" });
            const userId = consumed.userId;
            const guildId = consumed.guildId;
            if (!guildId) return res.code(410).send({ error: "token has no guild — request a new link" });
            try {
                await grantVerifiedRole(guildId, userId);
                return { ok: true, userId, guildId };
            } catch (e: any) {
                console.error("[verify] failed to grant role:", e);
                return res.code(500).send({ error: "failed to grant role" });
            }
        }

        return res.code(400).send({ error: "missing answer or proof" });
    });

    // OAuth fast-track: bot already authenticated the user in-client via
    // Discord OAuth, so it can mint a fresh token and verify instantly
    fastify.post("/v1/verify/oauth/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });

        const guildId = resolveGuild((req.query as { guildId?: string }).guildId);
        if (!guildId) return res.code(400).send({ error: "no verification guild — configure one in the dashboard or pass ?guildId=" });
        if (await isVerified(guildId, userId))
            return { ok: true, alreadyVerified: true };

        try {
            await grantVerifiedRole(guildId, userId);
            return { ok: true };
        } catch (e: any) {
            console.error("[verify] failed to grant role (oauth):", e);
            return res.code(500).send({ error: "failed to grant role" });
        }
    });

    // mint a token for a user (used by the plugin's DM fallback flow)
    fastify.post("/v1/verify/mint/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        const guildId = resolveGuild((req.query as { guildId?: string }).guildId);
        if (!guildId) return res.code(400).send({ error: "no verification guild — configure one in the dashboard or pass ?guildId=" });
        const token = await mintToken(userId, guildId);
        return { token, url: `${Config.verification.siteUrl}/verify?t=${token}` };
    });

    // verification status — used by the website dashboard to show a
    // verified/not-verified badge for the logged-in user
    fastify.get("/v1/verify/status/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        const guildId = resolveGuild((req.query as { guildId?: string }).guildId);
        // no guild context: report verified if verified in ANY configured guild
        if (!guildId) {
            for (const id of getGuildConfigIds()) {
                if (await isVerified(id, userId)) return { userId, verified: true };
            }
            return { userId, verified: false };
        }
        return { userId, verified: await isVerified(guildId, userId) };
    });

    // ------------------------------------------------------------------
    // Per-guild verification setup (used by the dashboard's setup section)
    // The caller must include the guild in the OAuth session's guilds
    // (identify scope) and hold MANAGE_GUILD; server.js enforces the session
    // + permission checks and forwards ?userId= (the acting admin).
    // ------------------------------------------------------------------
    fastify.get("/v1/verify/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        const cfg = getGuildConfig(guildId);

        // provide channel/role pickers for the setup page (requires the bot
        // to share the guild; the caller's permission was checked by the bot
        // itself in my-guilds and re-checked on save)
        const guild = Vaius.guilds.get(guildId);
        // verification channels: text + announcement; rules channels: also
        // the community "rules channel" type (GUILD_GUIDE, type 4)
        const channels = guild
            ? getVisibleChannels(guild)
                .filter(c => c.type === 0 || c.type === 5)
                .map(c => ({ id: c.id, name: "#" + c.name, type: c.type }))
            : [];
        const rulesChannels = guild
            ? getVisibleChannels(guild)
                .filter(c => c.type === 0 || c.type === 4 || c.type === 5)
                .map(c => ({ id: c.id, name: (c.type === 4 ? "📜 " : "#") + c.name, type: c.type }))
            : [];
        const roles = guild
            ? [...guild.roles.values()]
                .filter(r => !r.managed && r.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: "@" + r.name }))
            : [];

        return { configured: !!cfg, config: cfg, channels, rulesChannels, roles, rulesText: getGuildRulesText(guildId) };
    });

    fastify.post("/v1/verify/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        const body = (req.body ?? {}) as { channelId?: string; roleId?: string; rulesChannelId?: string | null };
        const { channelId, roleId, rulesChannelId } = body;
        if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId ?? "") || !/^\d{17,20}$/.test(roleId ?? ""))
            return res.code(400).send({ error: "guildId, channelId and roleId are required snowflakes" });
        if (rulesChannelId != null && !/^\d{17,20}$/.test(rulesChannelId))
            return res.code(400).send({ error: "invalid rulesChannelId" });

        // guild must be reachable by the bot
        const guild = Vaius.guilds.get(guildId);
        if (!guild) return res.code(404).send({ error: "bot is not in that server — invite it first" });
        if (rejectHiddenChannel(res, guildId, channelId)) return;
        if (rejectHiddenChannel(res, guildId, rulesChannelId ?? undefined)) return;

        // the acting admin must be able to manage the guild right now
        const actingUser = (req.query as { userId?: string }).userId || "";
        if (actingUser) {
            const member = await guild.getMember(actingUser).catch(() => null);
            const canManage = !!member && (guild.ownerID === actingUser || member.permissions.has("MANAGE_GUILD"));
            if (!canManage) return res.code(403).send({ error: "you need Manage Server permission in that server" });
        }

        const cfg = {
            guildId,
            channelId: channelId!,
            roleId: roleId!,
            rulesChannelId: rulesChannelId || null,
            rulesText: getGuildRulesText(guildId),
            enabled: true,
        };
        try {
            await setGuildConfig(cfg, (req.query as { userId?: string }).userId || "0");
        } catch (e: any) {
            console.error("[verify] failed to save guild config:", e);
            return res.code(500).send({ error: "failed to save config" });
        }

        // post/refresh the card and set the channel read-only
        try {
            await ensureCard(cfg);
        } catch (e: any) {
            console.error("[verify] failed to post card:", e);
            return res.code(400).send({ error: "could not post the verification card in that channel — check my permissions there" });
        }

        return { ok: true, config: cfg };
    });

    fastify.delete("/v1/verify/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        await disableGuildConfig(guildId);
        return { ok: true };
    });

    // Per-guild rules text (dashboard editor)
    fastify.get("/v1/verify/guild/:guildId/rules", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        return { text: getGuildRulesText(guildId) };
    });

    fastify.post("/v1/verify/guild/:guildId/rules", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        const body = (req.body ?? {}) as { text?: string };
        const text = (body.text ?? "").trim();

        const guild = Vaius.guilds.get(guildId);
        if (!guild) return res.code(404).send({ error: "bot is not in that server" });
        const cfg = getGuildConfig(guildId);
        if (!cfg?.rulesChannelId) return res.code(400).send({ error: "set the verification config first (rules channel is part of it)" });

        // acting admin must be able to manage the guild
        const actingUser = (req.query as { userId?: string }).userId || "";
        if (actingUser) {
            const member = await guild.getMember(actingUser).catch(() => null);
            if (!member || (guild.ownerID !== actingUser && !member.permissions.has("MANAGE_GUILD")))
                return res.code(403).send({ error: "you need Manage Server permission in that server" });
        }

        await setGuildRulesText(guildId, text || null);
        try {
            await lockRulesChannel(cfg.rulesChannelId, guildId);
            await ensureRulesCard(guildId, cfg.rulesChannelId);
        } catch (e: any) {
            console.error("[verify] failed to update rules card:", e);
            return res.code(400).send({ error: "saved, but could not update the rules card — check my permissions in that channel" });
        }
        return { ok: true };
    });

    // batch configs for the plugin: which of the given guilds (that the bot
    // shares) have verification configured. Public — channel/role ids are
    // already visible to members; no secrets here.
    fastify.get("/v1/verify/guilds", async (req, res) => {
        verifyCors(req, res);
        const ids = (req.query as { ids?: string }).ids || "";
        const out: { guildId: string; channelId: string; rulesChannelId: string | null; roleId: string }[] = [];
        for (const id of ids.split(",").slice(0, 100)) {
            if (!/^\d{17,20}$/.test(id)) continue;
            const cfg = getGuildConfig(id);
            if (cfg) out.push({ guildId: cfg.guildId, channelId: cfg.channelId, rulesChannelId: cfg.rulesChannelId, roleId: cfg.roleId });
        }
        return { guilds: out };
    });

    // list guilds the acting user administers (for the setup page picker)
    fastify.get("/v1/verify/my-guilds", async (req, res) => {
        verifyCors(req, res);
        const userId = (req.query as { userId?: string }).userId || "";
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        // guild ids from the OAuth session's guilds scope; when absent (plain
        // dashboard logins), fall back to every guild the bot shares with the user
        const requestedIds = (req.query as { ids?: string }).ids || "";
        const ids = requestedIds
            ? requestedIds.split(",").filter(i => /^\d{17,20}$/.test(i))
            : [...Vaius.guilds.keys()];
        const out: { id: string; name: string; icon: string | null; configured: boolean; canManage: boolean }[] = [];
        for (const id of ids) {
            const guild = Vaius.guilds.get(id);
            if (!guild) continue;
            const member = await guild.getMember(userId).catch(() => null);
            if (!member) continue;
            const perms = guild.ownerID === userId || member.permissions.has("MANAGE_GUILD");
            out.push({
                id: guild.id,
                name: guild.name,
                icon: guild.icon ?? null,
                configured: !!getGuildConfig(guild.id),
                canManage: perms,
            });
        }
        return { guilds: out };
    });

    // ------------------------------------------------------------------
    // Per-guild counting setup (dashboard). Same trust model as verification:
    // server.js checks the OAuth session; here we re-check Manage Server.
    // ------------------------------------------------------------------
    fastify.get("/v1/counting/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        const cfg = getCountingConfig(guildId);
        const guild = Vaius.guilds.get(guildId);
        const channels = guild
            ? getVisibleChannels(guild)
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: "#" + c.name }))
            : [];
        return { configured: !!cfg, config: cfg, channels };
    });

    fastify.post("/v1/counting/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        const body = (req.body ?? {}) as { channelId?: string; startAt?: number };
        const { channelId } = body;
        if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId ?? ""))
            return res.code(400).send({ error: "guildId and channelId are required snowflakes" });

        const guild = Vaius.guilds.get(guildId);
        if (!guild) return res.code(404).send({ error: "bot is not in that server — invite it first" });
        if (rejectHiddenChannel(res, guildId, channelId)) return;

        const actingUser = (req.query as { userId?: string }).userId || "";
        if (actingUser) {
            const member = await guild.getMember(actingUser).catch(() => null);
            if (!member || (guild.ownerID !== actingUser && !member.permissions.has("MANAGE_GUILD")))
                return res.code(403).send({ error: "you need Manage Server permission in that server" });
        }

        const prev = getCountingConfig(guildId);
        const startAt = Number.isFinite(body.startAt) ? Math.max(0, Math.floor(Number(body.startAt))) : (prev?.current ?? 0);
        const cfg = {
            guildId,
            channelId: channelId!,
            current: startAt,
            lastUserId: null as string | null,
            best: Math.max(startAt, prev?.best ?? 0),
            recordMessageId: prev?.recordMessageId ?? null,
            enabled: true,
        };
        try {
            await setCountingConfig(cfg, actingUser || "0");
        } catch (e: any) {
            console.error("[counting] failed to save config:", e);
            return res.code(500).send({ error: "failed to save config" });
        }

        try {
            await Vaius.rest.channels.createMessage(channelId!, {
                content: `🔢 **Counting is live!** The next number is **${startAt + 1}**. One person per number, no double-counting — good luck!\n-# Record so far: **${cfg.best}**`,
                allowedMentions: { everyone: false },
            });
        } catch (e: any) {
            console.error("[counting] failed to post announcement:", e);
            return res.code(400).send({ error: "saved, but could not post in that channel — check my permissions there" });
        }
        return { ok: true, config: cfg };
    });

    fastify.delete("/v1/counting/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        await disableCountingConfig(guildId);
        return { ok: true };
    });

    // ------------------------------------------------------------------
    // Per-guild welcomer setup (dashboard). Same trust model as counting.
    // ------------------------------------------------------------------
    fastify.get("/v1/welcomer/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        const cfg = getWelcomerConfig(guildId);
        const guild = Vaius.guilds.get(guildId);
        const channels = guild
            ? getVisibleChannels(guild)
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: "#" + c.name }))
            : [];
        return { configured: !!cfg, config: cfg, channels };
    });

    // Shared guard for dashboard saves: the chosen channel must be one the bot
    // can actually see (obfuscated = hidden by Private Channel Obfuscation =
    // the bot cannot read or post there).
    const rejectHiddenChannel = (res: import("fastify").FastifyReply, guildId: string, channelId: string | undefined) => {
        if (!channelId) return false;
        const guild = Vaius.guilds.get(guildId);
        const channel = guild?.channels.get(channelId);
        if (channel && isChannelObfuscated(channel)) {
            void res.code(400).send({ error: "I can't see that channel (no View Channel permission) — pick one I can access" });
            return true;
        }
        return false;
    };

    fastify.post("/v1/welcomer/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        const body = (req.body ?? {}) as { channelId?: string; message?: string };
        const { channelId, message } = body;
        if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId ?? ""))
            return res.code(400).send({ error: "guildId and channelId are required snowflakes" });
        if (!message || typeof message !== "string" || message.length > 1000)
            return res.code(400).send({ error: "message is required (max 1000 chars)" });

        const guild = Vaius.guilds.get(guildId);
        if (!guild) return res.code(404).send({ error: "bot is not in that server — invite it first" });
        if (rejectHiddenChannel(res, guildId, channelId)) return;

        const actingUser = (req.query as { userId?: string }).userId || "";
        if (actingUser) {
            const member = await guild.getMember(actingUser).catch(() => null);
            if (!member || (guild.ownerID !== actingUser && !member.permissions.has("MANAGE_GUILD")))
                return res.code(403).send({ error: "you need Manage Server permission in that server" });
        }

        // sanity check: the bot must be able to speak in that channel
        try {
            await Vaius.rest.channels.createMessage(channelId!, {
                content: "👋 Welcomer configured! New members will be greeted here.",
                allowedMentions: { everyone: false },
            });
        } catch (e: any) {
            console.error("[welcomer] failed to post test message:", e);
            return res.code(400).send({ error: "could not post in that channel — check my permissions there" });
        }

        const cfg = { guildId, channelId: channelId!, message: message!, enabled: true };
        try {
            await setWelcomerConfig(cfg, actingUser || "0");
        } catch (e: any) {
            console.error("[welcomer] failed to save config:", e);
            return res.code(500).send({ error: "failed to save config" });
        }
        return { ok: true, config: cfg };
    });

    fastify.delete("/v1/welcomer/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        await disableWelcomerConfig(guildId);
        return { ok: true };
    });

    // ------------------------------------------------------------------
    // Per-guild leveling setup (dashboard). Same trust model as counting.
    // ------------------------------------------------------------------
    fastify.get("/v1/leveling/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        const cfg = getLevelingConfig(guildId);
        const guild = Vaius.guilds.get(guildId);
        const channels = guild
            ? getVisibleChannels(guild)
                .filter(c => c.type === 0)
                .map(c => ({ id: c.id, name: "#" + c.name }))
            : [];
        const leaderboard = await getLeaderboard(guildId).catch(() => []);
        return { configured: !!cfg, config: cfg, channels, leaderboard };
    });

    fastify.post("/v1/leveling/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        const body = (req.body ?? {}) as { announceChannelId?: string | null };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });

        const guild = Vaius.guilds.get(guildId);
        if (!guild) return res.code(404).send({ error: "bot is not in that server — invite it first" });

        const actingUser = (req.query as { userId?: string }).userId || "";
        if (actingUser) {
            const member = await guild.getMember(actingUser).catch(() => null);
            if (!member || (guild.ownerID !== actingUser && !member.permissions.has("MANAGE_GUILD")))
                return res.code(403).send({ error: "you need Manage Server permission in that server" });
        }

        const announceChannelId = body.announceChannelId || null;
        if (rejectHiddenChannel(res, guildId, announceChannelId ?? undefined)) return;
        if (announceChannelId && !/^\d{17,20}$/.test(announceChannelId))
            return res.code(400).send({ error: "invalid announce channel id" });

        const cfg = { guildId, announceChannelId, enabled: true };
        try {
            await setLevelingConfig(cfg, actingUser || "0");
        } catch (e: any) {
            console.error("[leveling] failed to save config:", e);
            return res.code(500).send({ error: "failed to save config" });
        }

        if (announceChannelId) {
            try {
                await Vaius.rest.channels.createMessage(announceChannelId, {
                    content: "📈 **Leveling is live!** Members now earn XP by chatting here — level up to climb the leaderboard.",
                    allowedMentions: { everyone: false },
                });
            } catch (e: any) {
                console.error("[leveling] failed to post announcement:", e);
                return res.code(400).send({ error: "saved, but could not post in that channel — check my permissions there" });
            }
        }
        return { ok: true, config: cfg };
    });

    fastify.delete("/v1/leveling/guild/:guildId", async (req, res) => {
        verifyCors(req, res);
        const { guildId } = req.params as { guildId: string };
        if (!/^\d{17,20}$/.test(guildId)) return res.code(400).send({ error: "invalid guild id" });
        await disableLevelingConfig(guildId);
        return { ok: true };
    });

    // OAuth configuration for the website's tokenless "Verify with Discord"
    // button (the /v1/verify/* prefix is proxied by server.js).
    fastify.get("/v1/verify/oauth/settings", async (req, res) => {
        verifyCors(req, res);
        return { clientId: Config.verification.clientId, siteUrl: Config.verification.siteUrl };
    });

    // Human challenge for the in-client plugin flow (keyed by user id).
    // The OAuth callback refuses to grant the role until this is solved.
    fastify.get("/v1/verify/challenge/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        return { challenge: currentChallenge(`u:${userId}`) };
    });

    fastify.post("/v1/verify/challenge/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        const body = (req.body ?? {}) as { answer?: string };
        if (typeof body.answer !== "string") return res.code(400).send({ error: "missing answer" });
        const result = submitAnswer(`u:${userId}`, body.answer);
        if (!result.done)
            return { ok: false, restart: result.restart, challenge: { round: result.round, total: result.total, question: result.question } };
        return { ok: true, solved: true };
    });

    // Website flow: after solving the challenge post-OAuth, claim the role.
    fastify.post("/v1/verify/challenge/:userId/claim", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        if (!challengeSolved(`u:${userId}`))
            return res.code(403).send({ error: "challenge not solved" });
        clearChallenge(`u:${userId}`);
        const guildId = resolveGuild((req.query as { guildId?: string }).guildId);
        if (!guildId) return res.code(400).send({ error: "no verification guild — configure one in the dashboard or pass ?guildId=" });
        try {
            await grantVerifiedRole(guildId, userId);
            return { ok: true };
        } catch (e: any) {
            console.error("[verify] failed to grant role (claim):", e);
            return res.code(500).send({ error: "failed to grant role" });
        }
    });

    // OAuth callback fast-track: the server.js dispatcher forwards state=verify
    // here with ?code=...; we exchange the code with Discord ourselves and
    // grant the verified role to the authenticated user.
    fastify.get("/v1/verify/oauth/callback", async (req, res) => {
        verifyCors(req, res);
        const { code } = req.query as { code?: string };
        if (!code) return res.code(400).send({ error: "missing code" });

        try {
            const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: Config.verification.clientId,
                    client_secret: process.env.DISCORD_CLIENT_SECRET || "",
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: `${Config.verification.siteUrl}/v1/oauth/callback`,
                    scope: "identify"
                })
            });
            if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
            const { access_token } = await tokenRes.json() as { access_token: string };

            const userRes = await fetch("https://discord.com/api/users/@me", {
                headers: { Authorization: `Bearer ${access_token}` }
            });
            if (!userRes.ok) throw new Error("failed to fetch user");
            const { id } = await userRes.json() as { id: string };

            // the in-client plugin must have solved the human challenge first;
            // the website flow (no challenge yet) is bounced back to the page,
            // which runs the challenge for this user and claims afterwards.
            const requestedGuild = (req.query as { guild_id?: string }).guild_id;
            if (!challengeSolved(`u:${id}`))
                return res.redirect(`${Config.verification.siteUrl}/verify?challenge=1&uid=${id}${requestedGuild ? `&guild=${requestedGuild}` : ""}`);
            clearChallenge(`u:${id}`);

            const guildId = resolveGuild(requestedGuild);
            if (!guildId) return res.redirect(`${Config.verification.siteUrl}/verify?challenge=1&uid=${id}&noguild=1`);
            if (await isVerified(guildId, id)) return { ok: true, userId: id, alreadyVerified: true };
            await grantVerifiedRole(guildId, id);
            // browsers land here directly — bounce to a friendly page instead
            // of showing raw JSON
            return res.redirect(`${Config.verification.siteUrl}/verify?done=1`);
        } catch (e: any) {
            console.error("[verify] oauth callback failed:", e);
            return res.code(500).send({ error: e.message ?? "verification failed" });
        }
    });

    // defer listen to allow for fastify plugins to be registered before starting the server
    setImmediate(() => {
        fastify.listen({ port: port }, err => {
            if (err) {
                fastify.log.error(err);
                process.exit(1);
            }
        });
    });
}

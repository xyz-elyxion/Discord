import Fastify from "fastify";

import { readFile } from "fs/promises";
import Config from "./config";
import { PROD } from "./constants";
import { getGitRemote } from "./util/git";
import { makeLazy } from "./util/lazy";
import { challengeSolved, clearChallenge, consumeToken, currentChallenge, disableGuildConfig, ensureCard, getGuildConfig, getTokenInfo, grantVerifiedRole, isVerified, mintToken, setGuildConfig, submitAnswer } from "./modules/verification";
import { Vaius } from "./Client";

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

        const guildId = (req.query as { guildId?: string }).guildId || Config.homeGuildId;
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
        const guildId = (req.query as { guildId?: string }).guildId || Config.homeGuildId;
        const token = await mintToken(userId, guildId);
        return { token, url: `${Config.verification.siteUrl}/verify?t=${token}` };
    });

    // verification status — used by the website dashboard to show a
    // verified/not-verified badge for the logged-in user
    fastify.get("/v1/verify/status/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        const guildId = (req.query as { guildId?: string }).guildId || Config.homeGuildId;
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
        const channels = guild
            ? [...guild.channels.values()]
                .filter(c => c.type === 0 || c.type === 5) // text + announcement
                .map(c => ({ id: c.id, name: "#" + c.name, type: c.type }))
            : [];
        const roles = guild
            ? [...guild.roles.values()]
                .filter(r => !r.managed && r.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: "@" + r.name }))
            : [];

        return { configured: !!cfg, config: cfg, channels, roles };
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
        const ids = (req.query as { ids?: string }).ids || "";
        const out: { id: string; name: string; icon: string | null; configured: boolean; canManage: boolean }[] = [];
        for (const id of ids.split(",").filter(i => /^\d{17,20}$/.test(i)) ) {
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
        const guildId = (req.query as { guildId?: string }).guildId || Config.homeGuildId;
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
            if (!challengeSolved(`u:${id}`))
                return res.redirect(`${Config.verification.siteUrl}/verify?challenge=1&uid=${id}`);
            clearChallenge(`u:${id}`);

            const guildId = (req.query as { guildId?: string }).guildId || Config.homeGuildId;
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

import Fastify from "fastify";

import { readFile } from "fs/promises";
import Config from "./config";
import { PROD } from "./constants";
import { getGitRemote } from "./util/git";
import { makeLazy } from "./util/lazy";
import { challengeSolved, clearChallenge, consumeToken, currentChallenge, getTokenInfo, grantVerifiedRole, isVerified, mintToken, submitAnswer } from "./modules/verification";

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
            const userId = await consumeToken(token);
            if (!userId) return res.code(410).send({ error: "token already used or invalid" });
            try {
                await grantVerifiedRole(userId);
                return { ok: true, userId };
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

        if (await isVerified(userId))
            return { ok: true, alreadyVerified: true };

        try {
            await grantVerifiedRole(userId);
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
        const token = await mintToken(userId);
        return { token, url: `${Config.verification.siteUrl}/verify?t=${token}` };
    });

    // verification status — used by the website dashboard to show a
    // verified/not-verified badge for the logged-in user
    fastify.get("/v1/verify/status/:userId", async (req, res) => {
        verifyCors(req, res);
        const { userId } = req.params as { userId: string };
        if (!/^\d{17,20}$/.test(userId)) return res.code(400).send({ error: "invalid userId" });
        return { userId, verified: await isVerified(userId) };
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
        try {
            await grantVerifiedRole(userId);
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

            if (await isVerified(id)) return { ok: true, userId: id, alreadyVerified: true };
            await grantVerifiedRole(id);
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

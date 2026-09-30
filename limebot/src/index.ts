import "./config";

import "./Commands";

import "__modules__";

import {
    DiscordHTTPError
} from "oceanic.js";

import { Vaius, applyProxy, getProxyUrl, testProxy } from "./Client";
import { announceStatus } from "./modules/statusAnnouncer";
import { PROD } from "./constants";

import { initModListeners } from "./modules/moderation/listeners";
import { initAutoMod } from "./modules/moderation/autoMod";
import { initRulesPage } from "./modules/rulesPage";
import { initScheduledUnbans } from "./commands/moderation/tempban";
import { silently } from "./util/functions";
import { inspect } from "./util/inspect";
import { logDevDebug } from "./util/logAction";
import { toCodeblock } from "./util/text";

initModListeners();
initAutoMod();
initRulesPage();
initScheduledUnbans();

export async function handleError(title: string, err: unknown) {
    if (err instanceof DiscordHTTPError && err.status >= 500)
        return;

    console.error(`${title}:`, err);

    if (!PROD) return;

    const stack = err instanceof Error && err.stack;
    const text = stack || inspect(err);

    await logDevDebug({
        embeds: [{
            title,
            description: toCodeblock(text, stack ? "js" : ""),
            color: 0xff0000
        }]
    });
}

process.on("unhandledRejection", err => handleError("Unhandled Rejection", err));

process.on("uncaughtException", async err => {
    await silently(handleError("Uncaught Exception. Restarting process", err));
    process.exit(1);
});

Vaius.on("error", err => {
    // Ignore 5xx errors from Discord
    if (String(err).includes("Unexpected server response: 5"))
        return;

    handleError("Unhandled Client Error", err);
});

async function connectWithRetry(attempt = 1): Promise<void> {
    try {
        await Vaius.connect();
        console.log("Connected to Discord gateway");
        await announceStatus("", false);
    } catch (err: any) {
        const isRateLimit = err?.cause?.name === "RateLimitedError" || err?.cause?.delay != null;
        const rateLimitDelay: number | undefined = err?.cause?.delay;
        const delay = rateLimitDelay != null
            ? Math.min(rateLimitDelay + 10_000, 5 * 60_000)
            : Math.min(2 ** attempt * 60_000, 10 * 60_000);
        console.error(`Failed to connect to Discord gateway (attempt ${attempt}), retrying in ${Math.round(delay / 1000)}s:`, err);
        if (isRateLimit) {
            await announceStatus(
                `The bot hit Discord's IP rate limit while connecting (retry in ~${Math.round(delay / 1000)}s). ` +
                "Limey V1 itself is unaffected — installing and updating still work.",
                true
            );
        }
        setTimeout(() => connectWithRetry(attempt + 1), delay).unref();
    }
}

connectWithRetry();

// Proxy health check — every 5 minutes, test the configured proxy against
// Discord's API. If it fails, log it; a subsequent successful check clears
// the warning. The proxy is re-applied on each successful test so a flaky
// agent gets a fresh connection.
const PROXY_CHECK_MS = 5 * 60 * 1000;
let proxyWasFailing = false;

async function checkProxy() {
    const url = getProxyUrl();
    if (!url) return;

    try {
        const latency = await testProxy(url);
        applyProxy(url);
        if (proxyWasFailing) {
            proxyWasFailing = false;
            console.log(`[proxy] recovered (${latency}ms)`);
        }
    } catch (err: any) {
        if (!proxyWasFailing) {
            proxyWasFailing = true;
            console.error(`[proxy] health check FAILED: ${err?.message} — traffic may fall back to direct`);
        }
    }
}

setInterval(checkProxy, PROXY_CHECK_MS).unref();

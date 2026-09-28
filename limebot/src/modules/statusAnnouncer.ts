import Config from "../config";

// Status announcer — when the bot hits a Discord rate limit (or other
// widespread API issues), it posts to the status webhook, updates the
// server's public /v1/status endpoint (which the site banner and the
// Limey V1 client mod display), and clears it when things recover.

// Status webhook (hard-coded)
const WEBHOOK_URL = "https://discord.com/api/webhooks/1553963229087277077/nvr3y2bekC6clU7QOkFA50MU6rUMaBpp3nfy-AfpbEOO6o_kijPuRMhXFTpqA1kN9kFe";

let currentMessage = "";

export async function announceStatus(message: string, active: boolean) {
    // Only post to the webhook when the state changes
    if (active && currentMessage !== message) {
        currentMessage = message;
        console.log("[status] rate limited:", message);
        if (WEBHOOK_URL) {
            try {
                const res = await fetch(WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        username: "Limey Status",
                        embeds: [{
                            title: "⚠️ Discord is rate limiting us",
                            description: message,
                            color: 0xffa500,
                            timestamp: new Date().toISOString()
                        }]
                    }),
                    signal: AbortSignal.timeout(15_000)
                });
                if (!res.ok) console.error("[status] webhook POST failed:", res.status);
            } catch (err: any) {
                console.error("[status] webhook POST failed:", err?.message);
            }
        }
    } else if (!active) {
        if (!currentMessage) return;
        currentMessage = "";
        console.log("[status] recovered — clearing status");
        if (WEBHOOK_URL) {
            try {
                await fetch(WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        username: "Limey Status",
                        embeds: [{
                            title: "✅ Back to normal",
                            description: "Discord rate limiting has cleared — everything should work normally again.",
                            color: 0x9eea6f,
                            timestamp: new Date().toISOString()
                        }]
                    }),
                    signal: AbortSignal.timeout(15_000)
                });
            } catch (err: any) {
                console.error("[status] webhook POST failed:", err?.message);
            }
        }
    }

    // Push to the site/client status endpoint (fire and forget). Direct and
    // webhook posts both go through Discord, so this runs on a delay.
    if (Config.limeyApiBase) {
        setTimeout(() => {
            fetch(`${Config.limeyApiBase}/v1/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ active, message: active ? message : "" })
            }).catch(() => {});
        }, 3000).unref();
    }
}

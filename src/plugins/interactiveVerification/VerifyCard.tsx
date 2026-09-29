/*
 * Limey V1 — InteractiveVerification plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, FluxDispatcher, OAuth2AuthorizeModal, openModal, useState, UserStore } from "@webpack/common";

import { API_BASE, RULES_CHANNEL_ID } from "./shared";

// The bot application is the OAuth app (same client id as the bot itself).
// The Go cloud backend exposes the client id at /v1/oauth/settings — but to
// keep verification self-contained we hardcode the bot's application id.
const CLIENT_ID = "1514929209158402078";
const REDIRECT_URI = "https://limey-discord.onrender.com/v1/oauth/callback";
const SITE_ORIGIN = "https://limey-discord.onrender.com";

type Phase = "idle" | "authorizing" | "verifying" | "done" | "error";

export function VerifyCard() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState("");

    async function verifyWithClientMod(response: { location: string }) {
        setPhase("verifying");
        try {
            // Tag the shared OAuth callback so server.js dispatches the code
            // exchange to the limebot, which verifies and returns {ok, userId}.
            const url = new URL(response.location);
            url.searchParams.append("clientMod", "verify");
            url.searchParams.set("state", "verify");
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "authorization failed");
            const data = await res.json();
            if (!data.ok) throw new Error(data.error ?? "verification failed");
            setPhase("done");
        } catch (e: any) {
            setError(String(e?.message ?? e));
            setPhase("error");
        }
    }

    function startOAuth() {
        setPhase("authorizing");
        openModal(props =>
            <OAuth2AuthorizeModal
                {...props}
                scopes={["identify"]}
                responseType="code"
                redirectUri={REDIRECT_URI}
                permissions={0n}
                clientId={CLIENT_ID}
                cancelCompletesFlow={false}
                callback={async (response: { location: string }) => {
                    try {
                        await verifyWithClientMod(response);
                    } catch (e: any) {
                        setError(String(e?.message ?? e));
                        setPhase("error");
                    }
                }}
            />
        );
    }

    const busy = phase === "authorizing" || phase === "verifying";

    return (
        <div className="limey-interactive-verify-root">
            <div className="limey-iv-card">
                <div className="limey-iv-logo">🍋</div>
                <div className="limey-iv-title">
                    {phase === "done" ? "You're verified!" : "Verify to join"}
                </div>
                <div className="limey-iv-subtitle">
                    {phase === "done"
                        ? "Your verified role has been granted — head back and enjoy the server."
                        : "Prove you're human with your Limey V1 account. One click, no website."}
                </div>

                {phase === "done" ? (
                    <Button onClick={() => FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: RULES_CHANNEL_ID })}>
                        Read the Rules
                    </Button>
                ) : phase === "error" ? (
                    <>
                        <div className="limey-iv-error">⚠ {error}</div>
                        <Button onClick={() => { setPhase("idle"); setError(""); }}>Try Again</Button>
                        <a className="limey-iv-alt" href={`${SITE_ORIGIN}/verify`} target="_blank" rel="noreferrer">
                            Verify on the website instead
                        </a>
                    </>
                ) : (
                    <>
                        <Button onClick={startOAuth} disabled={busy} color={Button.Colors.BRAND}>
                            {busy ? "Verifying…" : "⚡ Instant Verify"}
                        </Button>
                        <a className="limey-iv-alt" href={`${SITE_ORIGIN}/verify`} target="_blank" rel="noreferrer">
                            Verify on the website instead
                        </a>
                    </>
                )}

                <div className="limey-iv-fine">
                    Verifying grants the verified role and agrees you'll follow the{" "}
                    <a href={`${SITE_ORIGIN}/rules.html`} target="_blank" rel="noreferrer">community rules</a>.
                    Powered by Limey V1.
                </div>
            </div>
        </div>
    );
}

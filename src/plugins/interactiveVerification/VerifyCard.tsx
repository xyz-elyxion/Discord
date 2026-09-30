/*
 * Limey V1 — InteractiveVerification plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@components/Item";
import { FluxDispatcher, OAuth2AuthorizeModal, openModal, useState } from "@webpack/common";

import { RULES_CHANNEL_ID } from "./shared";

// The bot application is the OAuth app (same client id as the bot itself).
const CLIENT_ID = "1514929209158402078";
const REDIRECT_URI = "https://limey-discord.onrender.com/v1/oauth/callback";
const SITE_ORIGIN = "https://limey-discord.onrender.com";

type Phase = "idle" | "authorizing" | "verifying" | "done" | "error";

export function VerifyCard() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState("");

    function startOAuth() {
        setPhase("authorizing");
        openModal(props => {
            // If the user dismisses the OAuth modal without authorizing, reset
            // back to idle instead of being stuck on "Verifying…" forever.
            const origOnClose = props.onClose;
            props.onClose = () => {
                setPhase(p => (p === "done" || p === "error" ? p : "idle"));
                origOnClose?.();
            };
            return (
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
                        setPhase("verifying");
                        // Tag the shared OAuth callback so server.js dispatches
                        // the code exchange to the limebot, which verifies and
                        // returns {ok, userId}.
                        const url = new URL(response.location);
                        url.searchParams.append("clientMod", "verify");
                        url.searchParams.set("state", "verify");
                        // Hard 15s timeout so a hung request can never leave the
                        // UI stuck on "Verifying…"
                        const res = await fetch(url, {
                            headers: { Accept: "application/json" },
                            signal: AbortSignal.timeout(15_000)
                        });
                        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? "authorization failed");
                        const data = await res.json();
                        if (!data.ok) throw new Error(data.error ?? "verification failed");
                        setPhase("done");
                    } catch (e: any) {
                        if (e?.name === "TimeoutError" || e?.name === "AbortError")
                            setError("the verification service took too long to respond");
                        else
                            setError(String(e?.message ?? e));
                        setPhase("error");
                    }
                }}
            />
            );
        });
    }

    const busy = phase === "authorizing" || phase === "verifying";

    return (
        <div className="limey-interactive-verify-root">
            <div className="limey-iv-stack">
                <div className={`limey-iv-header${phase === "done" ? " limey-iv-success" : ""}`}>
                    <div className="limey-iv-logo">🍋</div>
                    <div className="limey-iv-title">
                        {phase === "done" ? "You're verified!" : "Verify to join"}
                    </div>
                    <div className="limey-iv-subtitle">
                        {phase === "done"
                            ? "Your verified role has been granted — enjoy the server."
                            : "Prove you're human with your Limey V1 account. One click, no website."}
                    </div>
                </div>

                {/* Main verification item */}
                <Item variant="outline">
                    <ItemContent>
                        <ItemTitle>
                            {phase === "error" ? "Verification failed" : "Instant verification"}
                        </ItemTitle>
                        <ItemDescription>
                            {phase === "done" && "✅ Verified role granted. Welcome aboard!"}
                            {phase === "error" && `⚠ ${error}`}
                            {busy && "Waiting for Discord authorization…"}
                            {phase === "idle" && "Authorize with Discord and you're in immediately."}
                        </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                        {phase === "done" ? (
                            <Button
                                variant="secondary"
                                size="small"
                                onClick={() => FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: RULES_CHANNEL_ID })}
                            >
                                Read the Rules
                            </Button>
                        ) : (
                            <Button
                                onClick={startOAuth}
                                disabled={busy}
                                size="small"
                            >
                                {busy ? "Verifying…" : "⚡ Verify"}
                            </Button>
                        )}
                    </ItemActions>
                </Item>

                {/* Rules item */}
                <Item variant="normal">
                    <ItemMedia>📜</ItemMedia>
                    <ItemContent>
                        <ItemTitle>Read the community rules</ItemTitle>
                        <ItemDescription>
                            Verifying means you agree to follow the server guidelines.
                        </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                        <Button
                            variant="secondary"
                            size="small"
                            onClick={() => FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", channelId: RULES_CHANNEL_ID })}
                        >
                            Open
                        </Button>
                    </ItemActions>
                </Item>

                {/* Website fallback item */}
                <Item variant="normal">
                    <ItemMedia>🌐</ItemMedia>
                    <ItemContent>
                        <ItemTitle>Verify on the website</ItemTitle>
                        <ItemDescription>
                            Prefer the browser? Get a one-time link from the bot instead.
                        </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                        <Button
                            variant="link"
                            size="small"
                            onClick={() => window.open(`${SITE_ORIGIN}/verify`, "_blank")}
                        >
                            Visit
                        </Button>
                    </ItemActions>
                </Item>

                <div className="limey-iv-fine">
                    Powered by Limey V1 · Verification grants the verified role
                </div>
            </div>
        </div>
    );
}

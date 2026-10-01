/*
 * Limey V1 — InteractiveVerification plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@components/Item";
import { FluxDispatcher, OAuth2AuthorizeModal, openModal, UserStore, useState } from "@webpack/common";

import { API_BASE, RULES_CHANNEL_ID } from "./shared";

// The bot application is the OAuth app (same client id as the bot itself).
const CLIENT_ID = "1514929209158402078";
const REDIRECT_URI = "https://limey-discord.onrender.com/v1/oauth/callback";
const SITE_ORIGIN = "https://limey-discord.onrender.com";

type Phase = "idle" | "challenge" | "authorizing" | "verifying" | "done" | "error";

interface Challenge {
    round: number;
    total: number;
    question: string;
}

export function VerifyCard() {
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState("");
    const [challenge, setChallenge] = useState<Challenge | null>(null);
    const [answer, setAnswer] = useState("");
    const [challengeMsg, setChallengeMsg] = useState("");

    const userId = UserStore.getCurrentUser()?.id as string | undefined;

    async function startChallenge() {
        if (!userId) {
            setError("could not determine your user id — try again after the client fully loads");
            setPhase("error");
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/v1/verify/challenge/${userId}`, {
                signal: AbortSignal.timeout(10_000),
            });
            const text = await res.text();
            let data: any;
            try { data = JSON.parse(text); } catch { throw new Error(`verification service unavailable (${res.status})`); }
            if (!res.ok || !data.challenge) throw new Error(data.error ?? "failed to load challenge");
            if (data.challenge.solved) {
                startOAuth();
                return;
            }
            setChallenge(data.challenge);
            setChallengeMsg("");
            setPhase("challenge");
        } catch (e: any) {
            setError(e?.name === "TimeoutError" || e?.name === "AbortError"
                ? "the verification service took too long to respond"
                : String(e?.message ?? e));
            setPhase("error");
        }
    }

    async function submitAnswer() {
        if (!userId || !answer.trim()) return;
        try {
            const res = await fetch(`${API_BASE}/v1/verify/challenge/${userId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ answer: answer.trim() }),
                signal: AbortSignal.timeout(10_000),
            });
            let data: any;
            try { data = await res.json(); } catch { throw new Error(`verification service unavailable (${res.status})`); }
            if (res.ok && data.solved) {
                startOAuth();
                return;
            }
            if (res.ok && data.challenge) {
                setChallenge(data.challenge);
                setChallengeMsg(data.restart ? "Wrong answer — starting over." : "");
                setAnswer("");
                return;
            }
            throw new Error(data.error ?? "challenge failed");
        } catch (e: any) {
            setError(e?.name === "TimeoutError" || e?.name === "AbortError"
                ? "the verification service took too long to respond"
                : String(e?.message ?? e));
            setPhase("error");
        }
    }

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
                        // returns {ok, userId}. The server independently checks
                        // that this user solved the challenge.
                        const url = new URL(response.location);
                        url.searchParams.append("clientMod", "verify");
                        url.searchParams.set("state", "verify");
                        // Hard 15s timeout so a hung request can never leave the
                        // UI stuck on "Verifying…"
                        const res = await fetch(url, {
                            headers: { Accept: "application/json" },
                            signal: AbortSignal.timeout(15_000)
                        });
                        if (!res.ok) throw new Error(`authorization failed (${res.status})`);
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
                            : "Prove you're human: solve a short challenge, then authorize with Discord."}
                    </div>
                </div>

                {/* Main verification item */}
                <Item variant="outline">
                    <ItemContent>
                        <ItemTitle>
                            {phase === "error" ? "Verification failed" : phase === "challenge" ? "Human check" : "Instant verification"}
                        </ItemTitle>
                        <ItemDescription>
                            {phase === "done" && "✅ Verified role granted. Welcome aboard!"}
                            {phase === "error" && `⚠ ${error}`}
                            {busy && "Waiting for Discord authorization…"}
                            {phase === "idle" && "Solve a quick human check, then authorize — you're in immediately."}
                            {phase === "challenge" && `Question ${challenge?.round} of ${challenge?.total}`}
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
                        ) : phase === "challenge" ? (
                            <div className="limey-iv-challenge">
                                <div className="limey-iv-question">{challenge?.question}</div>
                                <div className="limey-iv-row">
                                    <input
                                        className="limey-iv-input"
                                        value={answer}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAnswer(e.target.value)}
                                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") submitAnswer(); }}
                                        placeholder="Your answer"
                                        autoFocus
                                    />
                                    <Button onClick={submitAnswer} size="small">Check</Button>
                                </div>
                                <div className="limey-iv-challenge-msg">{challengeMsg}</div>
                            </div>
                        ) : (
                            <Button
                                onClick={startChallenge}
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

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./../styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { analyzeGuild, analyzeInvite, GuildAnalysis, isAnalyzing } from "@plugins/checkers/serverChecker/analysis";
import { classNameFactory } from "@utils/css";
import { React, useEffect, useState } from "@webpack/common";

export const cl = classNameFactory("vc-server-checker-");

/** Accepts a raw snowflake, a discord.gg/BASE64-NUMERIC guild id, or a full invite URL */
export function parseGuildInput(input: string): { kind: "guildId" | "invite"; value: string; } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const inviteMatch = trimmed.match(/(?:discord\.gg\/|discord\.com\/invite\/)([\w-]+)/i);
    if (inviteMatch) return { kind: "invite", value: inviteMatch[1] };

    const snowflake = trimmed.match(/\d{15,25}/);
    if (snowflake) return { kind: "guildId", value: snowflake[0] };

    // A bare invite code (no URL) — anything alphanumeric of plausible length
    if (/^[A-Za-z0-9_-]{2,20}$/.test(trimmed)) return { kind: "invite", value: trimmed };

    return null;
}

function Row({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean; }) {
    return (
        <div className={cl("row")}>
            <span className={cl("row-label")}>{label}</span>
            <span className={`${cl("row-value")} ${warn ? cl("row-warn") : ""}`}>{value}</span>
        </div>
    );
}

function ScoreBar({ score, color }: { score: number; color: string; }) {
    return (
        <div className={cl("score-bar")}>
            <div className={cl("score-fill")} style={{ width: `${score}%`, background: color }} />
        </div>
    );
}

const LEVEL_ICON: Record<string, string> = {
    pass: "✅",
    warn: "⚠️",
    neutral: "➖",
};

function CheckItem({ check }: { check: GuildAnalysis["checks"][number]; }) {
    return (
        <div className={`${cl("check")} ${cl(`check-${check.level}`)}`}>
            <span className={cl("check-icon")}>{LEVEL_ICON[check.level]}</span>
            <div className={cl("check-body")}>
                <span className={cl("check-label")}>{check.label}</span>
                <span className={cl("check-note")}>{check.note}</span>
            </div>
        </div>
    );
}

function AnalysisView({ analysis }: { analysis: GuildAnalysis; }) {
    const band = getBand(analysis.score);
    const warnCount = analysis.checks.filter(c => c.level === "warn").length;
    const passCount = analysis.checks.filter(c => c.level === "pass").length;

    return (
        <div className={cl("analysis")}>
            <div className={cl("hero")} style={{ borderColor: band.color }}>
                <div className={cl("band")}>
                    <span className={cl("band-emoji")} style={{ background: band.color }}>{band.emoji}</span>
                    <div>
                        <span className={cl("band-label")} style={{ color: band.color }}>
                            {band.label} — {analysis.score}/100
                        </span>
                        <span className={cl("band-note")}>{band.note}</span>
                    </div>
                </div>
                <ScoreBar score={analysis.score} color={band.color} />
                <span className={cl("band-subnote")}>
                    {passCount} passed · {warnCount} flagged · {analysis.checks.length} checks run
                    {analysis.joined ? "" : " (from invite, partial)"}
                </span>
            </div>

            <div className={cl("checks")}>
                {analysis.checks.map(c => (
                    <CheckItem key={c.id} check={c} />
                ))}
            </div>

            <div className={cl("grid")}>
                <Row label="Created" value={analysis.createdAtLabel} />
                <Row label="Server age" value={`${analysis.ageDays.toLocaleString()} days`} />
                <Row label="Verification" value={["None", "Low", "Medium", "High", "Highest"][analysis.verificationLevel] ?? "?"} />
                <Row label="Boosts" value={`Level ${analysis.premiumTier} · ${analysis.boostCount}`} />
                <Row label="NSFW" value={["Default", "Explicit", "Safe", "Age-Restricted"][analysis.nsfwLevel] ?? "?"} warn={analysis.nsfwLevel === 1 || analysis.nsfwLevel === 3} />
                <Row
                    label="Trust features"
                    value={analysis.trustFeatures.length ? `${analysis.trustFeatures.length} earned` : "None"}
                />
            </div>

            {analysis.description && (
                <div className={cl("footer")}>“{analysis.description}”</div>
            )}

            {analysis.partial && (
                <div className={cl("footer")}>
                    Partial data — this analysis came from the invite, not a joined server. Join once to get emoji, sticker and check extras.
                </div>
            )}

            <div className={cl("footer")}>
                This is a heuristic, not proof. Nothing here replaces clicking links carefully — a verified
                server can still contain scammy users, and a small one can be perfectly safe.
            </div>
        </div>
    );
}

// Local copy to avoid a circular import of the constants/bands at module top when the modal is opened
import { SCORE_BANDS } from "@plugins/checkers/serverChecker/constants";

function getBand(score: number): (typeof SCORE_BANDS)[number] {
    return SCORE_BANDS.reduce((acc, band) => (score >= band.min ? band : acc), SCORE_BANDS[0]);
}

export function CheckerModal({ initialInput }: { initialInput?: string; }) {
    const [input, setInput] = useState(initialInput ?? "");
    const [pending, setPending] = useState<{ kind: "guildId" | "invite"; value: string; } | undefined>(initialInput ? parseGuildInput(initialInput) ?? undefined : undefined);
    const [analysis, setAnalysis] = useState<GuildAnalysis | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!pending) return;
        let alive = true;
        setAnalysis(null);
        setError(null);

        const job = pending.kind === "guildId"
            ? analyzeGuild(pending.value)
            : analyzeInvite(pending.value);

        job
            .then(a => {
                if (alive) {
                    if (!a) setError(pending.kind === "guildId"
                        ? "No joined server matches that ID — join it once, or paste a discord.gg/… invite link instead."
                        : "Couldn't resolve that invite — make sure the code is correct and hasn't expired.");
                    else setAnalysis(a);
                }
            })
            .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
    }, [pending, tick]);

    const loading = pending ? isAnalyzing(pending.value) : false;
    const resolved = analysis && analysis.guildId === pending?.value ? analysis : null;

    const handleLookup = () => {
        const parsed = parseGuildInput(input);
        if (!parsed) {
            setError("Couldn't read that. Paste a discord.gg/… invite link or a server ID.");
            return;
        }
        setError(null);
        setPending(parsed);
        setTick(t => t + 1);
    };

    return (
        <div className={cl("wrap")}>
            <div className={cl("search")}>
                <input
                    className={cl("search-input")}
                    placeholder="discord.gg/… invite or server ID…"
                    value={input}
                    onChange={e => { setInput(e.target.value); setError(null); }}
                    onKeyDown={e => { if (e.key === "Enter") handleLookup(); }}
                />
                <button className={cl("search-btn")} onClick={handleLookup}>Check</button>
            </div>

            {!pending && (
                <div className={cl("footer")}>
                    Paste a server's invite link (discord.gg/…) or its ID. The checker derives the server's
                    creation date from the ID and inspects verification level, boosts, AutoMod, trust
                    features, NSFW rating, and more — before you even join.
                </div>
            )}

            {error && <div className={`${cl("footer")} ${cl("error")}`}>{error}</div>}
            {pending && loading && !resolved && <div className={cl("footer")}>Analyzing…</div>}
            {resolved && <AnalysisView analysis={resolved} />}
        </div>
    );
}

export default ErrorBoundary.wrap(CheckerModal);

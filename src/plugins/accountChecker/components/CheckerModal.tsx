/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./../styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { useEffect, useState, React } from "@webpack/common";

import { analyzeUser, getCachedAnalysis, isAnalyzing, AccountAnalysis, getBand } from "../analysis";
import { settings } from "../settings";

export const cl = classNameFactory("vc-account-checker-");

/** Accepts a raw snowflake, a <@123> mention, or a discord.com/users/123 URL */
export function parseUserId(input: string): string | null {
    const match = input.trim().match(/\d{15,25}/);
    return match?.[0] ?? null;
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

function AnalysisView({ analysis }: { analysis: AccountAnalysis; }) {
    const band = getBand(analysis.score);

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
            </div>

            <div className={cl("grid")}>
                <Row label="Created" value={analysis.createdAtLabel} />
                <Row label="Account age" value={`${analysis.ageDays.toLocaleString()} days`} />
                <Row label="Badges" value={analysis.badgeDetails.length ? `${analysis.badgeDetails.length} earned` : "None yet"} />
                <Row label="Nitro" value={analysis.hasNitro ? "Active" : "Not active"} />
                <Row label="Banner" value={analysis.hasBanner ? "Custom" : "Default"} />
                <Row label="Bio" value={analysis.hasBio ? "Written" : "Empty"} />
                <Row label="Decoration" value={analysis.hasAvatarDecoration ? "Wearing one" : "None"} />
                <Row label="Connections" value={analysis.connectedAccountCount > 0 ? `${analysis.connectedAccountCount} linked` : "None"} />
            </div>

            {analysis.badgeDetails.length > 0 && (
                <div className={cl("badges")}>
                    {analysis.badgeDetails.map(b => (
                        <span key={b.id} className={`${cl("badge")} ${settings.store.showUnobtainableHints && b.expired ? cl("badge-expired") : ""}`}>
                            {b.id}{settings.store.showUnobtainableHints && b.expired ? " (unobtainable)" : ""}
                        </span>
                    ))}
                </div>
            )}

            {analysis.partial && (
                <div className={cl("footer")}>
                    Partial data: open this user's profile once in Discord to get the freshest signals.
                </div>
            )}

            <div className={cl("footer")}>
                This is a heuristic, not proof. A polished profile does not guarantee a good actor — and
                a bare one is not automatically an alt.
            </div>
        </div>
    );
}

export function CheckerModal({ initialUserId }: { initialUserId?: string; }) {
    const [input, setInput] = useState(initialUserId ?? "");
    const [userId, setUserId] = useState<string | undefined>(initialUserId);
    const [analysis, setAnalysis] = useState<AccountAnalysis | null>(() =>
        initialUserId ? getCachedAnalysis(initialUserId) ?? null : null
    );
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    useEffect(() => {
        if (!userId) return;
        let alive = true;
        setAnalysis(getCachedAnalysis(userId) ?? null);
        analyzeUser(userId)
            .then(a => { if (alive) setAnalysis(a); })
            .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
        return () => { alive = false; };
    }, [userId, tick]);

    const loading = userId ? isAnalyzing(userId) : false;
    const resolved = analysis && analysis.userId === userId ? analysis : null;

    const handleLookup = () => {
        const id = parseUserId(input);
        if (!id) {
            setError("Couldn't find a user ID in that. Paste an ID, a mention like <@123…>, or a discord.com/users/… link.");
            return;
        }
        setError(null);
        setUserId(id);
        setTick(t => t + 1);
    };

    return (
        <div className={cl("wrap")}>
            <div className={cl("search")}>
                <input
                    className={cl("search-input")}
                    placeholder="User ID, @mention, or profile link…"
                    value={input}
                    onChange={e => { setInput(e.target.value); setError(null); }}
                    onKeyDown={e => { if (e.key === "Enter") handleLookup(); }}
                />
                <button className={cl("search-btn")} onClick={handleLookup}>Check</button>
            </div>

            {!userId && (
                <div className={cl("footer")}>
                    Paste any Discord user's ID, mention or profile URL — right-click someone, or enable
                    Developer Mode in settings to copy IDs. The checker derives their account creation date
                    from the ID and pulls badges and profile investment signals from Discord.
                </div>
            )}

            {error && <div className={`${cl("footer")} ${cl("error")}`}>{error}</div>}
            {userId && loading && !resolved && <div className={cl("footer")}>Analyzing…</div>}
            {userId && resolved && <AnalysisView analysis={resolved} />}
        </div>
    );
}

export default ErrorBoundary.wrap(CheckerModal);

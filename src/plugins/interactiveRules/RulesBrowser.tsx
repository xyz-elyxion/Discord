/*
 * Limey V1 — InteractiveRules plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { useMemo, useState, TextInput } from "@webpack/common";

import { RULES, RULES_PAGE_URL, Rule, CATEGORIES } from "./rules";

const CATEGORY_COLORS: Record<string, string> = {
    Conduct: "#f04747",
    Community: "#faa61a",
    Security: "#b47ddf",
    Development: "#3ba55c",
    Content: "#e67e22",
    Server: "#00a8fc",
    Legal: "#747f8d"
};

function markRead(num: number) {
    try {
        const read = new Set<number>(JSON.parse(localStorage.getItem("limey-rules-read") ?? "[]"));
        read.add(num);
        localStorage.setItem("limey-rules-read", JSON.stringify([...read]));
    } catch { /* ignore */ }
}

function getRead(): Set<number> {
    try {
        return new Set<number>(JSON.parse(localStorage.getItem("limey-rules-read") ?? "[]"));
    } catch {
        return new Set();
    }
}

export function RulesBrowser({ variant, onClose }: { variant: "channel" | "overlay"; onClose?: () => void; }) {
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<string>("All");
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [read, setRead] = useState<Set<number>>(getRead);

    const filtered = useMemo(() => {
        const q = query.toLowerCase();
        return RULES.filter(r =>
            (category === "All" || r.category === category) &&
            (!q || r.title.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q) || r.details.some(d => d.toLowerCase().includes(q)))
        );
    }, [query, category]);

    const toggle = (num: number) => {
        setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(num)) next.delete(num); else next.add(num);
            if (next.has(num)) {
                markRead(num);
                setRead(getRead());
            }
            return next;
        });
    };

    const progress = Math.round((read.size / RULES.length) * 100);

    return (
        <div className="limey-interactive-rules-root">
            {/* Header */}
            <div className="limey-ir-header">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                        <div className="limey-ir-title">📜 Official Community Guidelines</div>
                        <div className="limey-ir-subtitle">Limey V1 — click a rule to expand it</div>
                    </div>
                    {variant === "overlay" && onClose && (
                        <button className="limey-ir-close" onClick={onClose}>✕</button>
                    )}
                </div>

                {/* Progress bar */}
                <div className="limey-ir-progress-track">
                    <div className="limey-ir-progress-bar">
                        <div className="limey-ir-progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="limey-ir-progress-label">{read.size}/{RULES.length} read</span>
                </div>

                {/* Search */}
                <div className="limey-ir-search">
                    <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search rules…"
                        style={{ width: "100%" }}
                    />
                </div>

                {/* Category filter chips */}
                <div className="limey-ir-chips">
                    {CATEGORIES.map(cat => (
                        <button
                            key={cat}
                            className={`limey-ir-chip${category === cat ? " limey-ir-chip-active" : ""}`}
                            onClick={() => setCategory(cat)}
                        >
                            {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Rule cards */}
            <div className="limey-ir-list">
                {filtered.map(rule => {
                    const isExpanded = expanded.has(rule.num);
                    const color = CATEGORY_COLORS[rule.category] ?? "#747f8d";
                    return (
                        <div
                            key={rule.num}
                            className="limey-ir-card"
                            style={isExpanded ? { borderColor: color } : undefined}
                            onClick={() => toggle(rule.num)}
                        >
                            <div className="limey-ir-card-header">
                                <div className="limey-ir-num" style={{ background: color }}>{rule.num}</div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className={`limey-ir-card-title${read.has(rule.num) ? " limey-ir-read" : ""}`}>
                                        {rule.title} {read.has(rule.num) && "✓"}
                                    </div>
                                    <div className="limey-ir-card-summary">{rule.summary}</div>
                                </div>
                                <div
                                    className="limey-ir-chevron"
                                    style={{ transform: isExpanded ? "rotate(180deg)" : "none" }}
                                >
                                    ▼
                                </div>
                            </div>
                            {isExpanded && (
                                <ul className="limey-ir-details">
                                    {rule.details.map((d, i) => (
                                        <li key={i}>
                                            <span style={{ color, marginRight: 6 }}>•</span>{d}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
                {!filtered.length && (
                    <div className="limey-ir-empty">No rules match "{query}"</div>
                )}

                {/* Footer */}
                <div className="limey-ir-footer">
                    Powered by{" "}
                    <a href={RULES_PAGE_URL} target="_blank" rel="noreferrer">
                        limey-discord.onrender.com/rules
                    </a>
                    {" "}· Limey V1 InteractiveRules
                </div>
            </div>
        </div>
    );
}

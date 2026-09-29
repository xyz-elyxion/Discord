/*
 * Limey V1 — InteractiveRules plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
        const read = new Set(JSON.parse(localStorage.getItem("limey-rules-read") ?? "[]"));
        read.add(num);
        localStorage.setItem("limey-rules-read", JSON.stringify([...read]));
    } catch { /* ignore */ }
}

function getRead(): Set<number> {
    try {
        return new Set(JSON.parse(localStorage.getItem("limey-rules-read") ?? "[]"));
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
        <div
            style={{
                position: variant === "overlay" ? "fixed" : "relative",
                inset: variant === "overlay" ? 0 : undefined,
                zIndex: variant === "overlay" ? 1000 : undefined,
                background: variant === "overlay" ? "var(--background-primary)" : "var(--background-primary)",
                display: "flex",
                flexDirection: "column",
                height: "100%",
                overflow: "hidden"
            }}
        >
            {/* Header */}
            <div style={{
                padding: "20px 24px 12px",
                borderBottom: "1px solid var(--background-modifier-accent)",
                flexShrink: 0
            }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div>
                        <div style={{ fontSize: 20, fontWeight: 700, color: "var(--header-primary)" }}>
                            📜 Official Community Guidelines
                        </div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                            Limey V1 — click a rule to expand it
                        </div>
                    </div>
                    {variant === "overlay" && onClose && (
                        <button
                            onClick={onClose}
                            style={{
                                background: "var(--background-modifier-hover)",
                                border: "none",
                                borderRadius: 8,
                                color: "var(--interactive-normal)",
                                cursor: "pointer",
                                fontSize: 16,
                                padding: "6px 12px"
                            }}
                        >
                            ✕
                        </button>
                    )}
                </div>

                {/* Progress bar */}
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{
                        flex: 1,
                        height: 6,
                        borderRadius: 3,
                        background: "var(--background-modifier-accent)",
                        overflow: "hidden"
                    }}>
                        <div style={{
                            width: `${progress}%`,
                            height: "100%",
                            background: "linear-gradient(90deg, #3ba55c, #00a8fc)",
                            transition: "width 0.3s ease"
                        }} />
                    </div>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                        {read.size}/{RULES.length} read
                    </span>
                </div>

                {/* Search */}
                <div style={{ marginTop: 12 }}>
                    <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search rules…"
                        style={{ width: "100%" }}
                    />
                </div>

                {/* Category filter chips */}
                <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {CATEGORIES.map(cat => (
                        <button
                            key={cat}
                            onClick={() => setCategory(cat)}
                            style={{
                                background: category === cat ? "var(--brand-500)" : "var(--background-modifier-hover)",
                                border: "none",
                                borderRadius: 999,
                                color: category === cat ? "#fff" : "var(--interactive-normal)",
                                cursor: "pointer",
                                fontSize: 12,
                                fontWeight: 600,
                                padding: "4px 12px",
                                transition: "background 0.15s"
                            }}
                        >
                            {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Rule cards */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 24px 24px" }}>
                {filtered.map(rule => {
                    const isExpanded = expanded.has(rule.num);
                    const color = CATEGORY_COLORS[rule.category] ?? "#747f8d";
                    return (
                        <div
                            key={rule.num}
                            onClick={() => toggle(rule.num)}
                            style={{
                                background: "var(--background-secondary)",
                                border: `1px solid ${isExpanded ? color : "var(--background-modifier-accent)"}`,
                                borderRadius: 10,
                                cursor: "pointer",
                                marginBottom: 8,
                                overflow: "hidden",
                                transition: "border-color 0.15s"
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
                                <div style={{
                                    background: color,
                                    borderRadius: 8,
                                    color: "#fff",
                                    flexShrink: 0,
                                    fontSize: 13,
                                    fontWeight: 700,
                                    minWidth: 32,
                                    padding: "4px 0",
                                    textAlign: "center"
                                }}>
                                    {rule.num}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        color: read.has(rule.num) ? "var(--text-muted)" : "var(--header-primary)",
                                        fontSize: 15,
                                        fontWeight: 600,
                                        textDecoration: read.has(rule.num) ? "line-through" : "none",
                                        textDecorationColor: "var(--status-green-560)"
                                    }}>
                                        {rule.title} {read.has(rule.num) && "✓"}
                                    </div>
                                    <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 2 }}>
                                        {rule.summary}
                                    </div>
                                </div>
                                <div style={{
                                    color: "var(--interactive-muted)",
                                    fontSize: 12,
                                    transform: isExpanded ? "rotate(180deg)" : "none",
                                    transition: "transform 0.2s"
                                }}>
                                    ▼
                                </div>
                            </div>
                            {isExpanded && (
                                <ul style={{
                                    borderTop: "1px solid var(--background-modifier-accent)",
                                    color: "var(--text-normal)",
                                    fontSize: 14,
                                    lineHeight: 1.6,
                                    listStyle: "none",
                                    margin: 0,
                                    padding: "12px 16px 14px 60px"
                                }}>
                                    {rule.details.map((d, i) => (
                                        <li key={i} style={{ marginBottom: 4 }}>
                                            <span style={{ color, marginRight: 6 }}>•</span>{d}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
                {!filtered.length && (
                    <div style={{
                        color: "var(--text-muted)",
                        padding: 32,
                        textAlign: "center"
                    }}>
                        No rules match "{query}"
                    </div>
                )}

                {/* Footer */}
                <div style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    marginTop: 16,
                    textAlign: "center"
                }}>
                    Powered by{" "}
                    <a href={RULES_PAGE_URL} target="_blank" rel="noreferrer" style={{ color: "var(--text-link)" }}>
                        limey-discord.onrender.com/rules
                    </a>
                    {" "}· Limey V1 InteractiveRules
                </div>
            </div>
        </div>
    );
}

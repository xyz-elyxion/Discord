/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, TextInput, useState } from "@webpack/common";

import { askCompanion, CompanionReply } from "./companion";
import { fallbackAnswer } from "./knowledgeBase";

const suggestions = [
    "What is Limey V1?",
    "How do I install plugins?",
    "Is this safe from bans?",
    "What are Discord roles?",
];

export function CompanionModal() {
    const [question, setQuestion] = useState("");
    const [history, setHistory] = useState<CompanionReply[]>([]);

    const ask = () => {
        const trimmed = question.trim();
        if (!trimmed) return;

        const reply = askCompanion(trimmed);
        if (!reply.answer) reply.answer = fallbackAnswer;
        setHistory(prev => [reply, ...prev]);
        setQuestion("");
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    maxHeight: "340px",
                    minHeight: "160px",
                    overflowY: "auto",
                    paddingRight: "4px",
                }}
            >
                {history.length === 0 && (
                    <div style={{ opacity: 0.8 }}>
                        <p style={{ margin: "0 0 8px" }}>
                            Hi! I'm Limey, your little companion. Ask me anything about Discord or Limey V1 and I'll
                            answer with the best thing I know.
                        </p>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            {suggestions.map(s => (
                                <Button
                                    key={s}
                                    size={Button.Sizes.SMALL}
                                    onClick={() => setQuestion(s)}
                                >
                                    {s}
                                </Button>
                            ))}
                        </div>
                    </div>
                )}

                {history.map((reply, i) => (
                    <div
                        key={history.length - i}
                        style={{
                            background: "var(--background-modifier-accent, rgba(0, 0, 0, 0.06))",
                            color: "var(--text-default, currentColor)",
                            borderRadius: "8px",
                            padding: "10px 12px",
                        }}
                    >
                        <div style={{ opacity: 0.6, fontSize: "12px", marginBottom: "4px" }}>
                            {reply.topic} — you asked: “{reply.question}”
                        </div>
                        {reply.answer}
                    </div>
                ))}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <TextInput
                    placeholder="Ask me anything..."
                    value={question}
                    onChange={setQuestion}
                    autoFocus
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                />
                <Button size={Button.Sizes.MEDIUM} color={Button.Colors.BRAND} onClick={ask}>
                    Ask
                </Button>
            </div>
        </div>
    );
}

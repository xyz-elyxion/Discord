/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, TextInput, useEffect, useRef, useState } from "@webpack/common";

import { askCompanion, CompanionReply, performAction } from "./companion";
import { fallbackAnswer } from "./knowledgeBase";

const suggestions = [
    "What is Limey V1?",
    "Open my settings",
    "Tell me a joke",
];

/** Follow-up question chips shown under each answer */
const followUps: Record<string, string[]> = {
    "Limey V1": [
        "How do themes work?",
        "Is this safe?",
        "Open the plugin panel",
    ],
    "Discord": [
        "What is Nitro?",
        "What are threads?",
        "How do polls work?",
    ],
    "Tips": [
        "What is the quick switcher?",
        "How do I organize servers?",
        "How do I fix my mic?",
    ],
    "Action": [
        "Open my settings",
        "What is Limey V1?",
    ],
    "Companion": [
        "What is Limey V1?",
        "What is Discord?",
    ],
};

/** Small talk replies for greetings and thanks */
const smallTalk: { keywords: string[]; replies: string[]; }[] = [
    {
        keywords: ["hi", "hello", "hey", "yo", "sup", "greetings"],
        replies: [
            "Hey! 🍋 Ask me about Discord or Limey V1 — or tell me to do stuff for you.",
            "Hello there! Need help with a plugin, a theme, or some Discord trivia?",
            "Hi! I'm here — try “open my settings” or ask “what is the soundboard?”"
        ]
    },
    {
        keywords: ["thanks", "thank", "ty", "thx", "appreciated"],
        replies: [
            "Anytime! 🍋",
            "Happy to help!",
            "You're welcome — ask me anything else."
        ]
    },
    {
        keywords: ["who are you", "your name", "what are you"],
        replies: [
            "I'm Limey, the little companion built into Limey V1 — part FAQ bot, part personal assistant. 🍋"
        ]
    },
    {
        keywords: ["joke", "funny", "laugh"],
        replies: [
            "Why did the Discord mod get banned? …They patched it without consent. 🍋",
            "I'd tell you an Electron joke, but it would take 300MB to load.",
            "A client mod walks into a Discord… and instantly gets 100+ plugins."
        ]
    }
];

function trySmallTalk(question: string): string | undefined {
    const q = question.toLowerCase();
    const words = new Set(q.split(/\W+/).filter(Boolean));
    for (const { keywords, replies } of smallTalk) {
        for (const k of keywords) {
            if (words.has(k) || (k.includes(" ") && q.includes(k))) {
                return replies[Math.floor(Math.random() * replies.length)];
            }
        }
    }
    return undefined;
}

export function CompanionModal() {
    const [question, setQuestion] = useState("");
    const [history, setHistory] = useState<CompanionReply[]>([]);
    const [followUpChips, setFollowUpChips] = useState<string[]>([]);
    const scrollerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    }, [history]);

    const ask = (raw?: string) => {
        const trimmed = (raw ?? question).trim();
        if (!trimmed) return;

        const small = trySmallTalk(trimmed);
        const reply: CompanionReply = small
            ? { question: trimmed, topic: "Companion", answer: small }
            : askCompanion(trimmed);

        if (!reply.answer) reply.answer = fallbackAnswer;
        if (reply.action) reply.answer = performAction(reply.action);

        setHistory(prev => [reply, ...prev]);
        setFollowUpChips(followUps[reply.topic] ?? followUps.Companion);
        setQuestion("");
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
            <div
                ref={scrollerRef}
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
                            Hi! I'm Limey, your little companion. Ask me anything about Discord or Limey V1 — or tell
                            me to <b>do stuff for you</b>: “open my settings”, “open plugins”, “restart Discord”.
                        </p>
                        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            {suggestions.map(s => (
                                <Button
                                    key={s}
                                    size={Button.Sizes.SMALL}
                                    onClick={() => ask(s)}
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

                {history.length > 0 && followUpChips.length > 0 && (
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        {followUpChips.slice(0, 3).map(s => (
                            <Button
                                key={s}
                                size={Button.Sizes.SMALL}
                                onClick={() => ask(s)}
                            >
                                {s}
                            </Button>
                        ))}
                    </div>
                )}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <TextInput
                    placeholder="Ask me anything..."
                    value={question}
                    onChange={setQuestion}
                    autoFocus
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                />
                <Button size={Button.Sizes.MEDIUM} color={Button.Colors.BRAND} onClick={() => ask()}>
                    Ask
                </Button>
            </div>
        </div>
    );
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CompanionEntry,knowledgeBase } from "./knowledgeBase";

export interface CompanionReply {
    question: string;
    topic: CompanionEntry["topic"] | "Companion";
    answer: string;
}

/**
 * Pick the best-matching predefined answer for a question.
 * Scores each entry by how many of its keywords appear in the question,
 * normalised by the number of question words so short questions aren't
 * biased against long ones.
 */
export function askCompanion(question: string): CompanionReply {
    const q = question.toLowerCase();
    const words = q.split(/\W+/).filter(Boolean);
    const uniqueWords = new Set(words);

    let best: CompanionEntry | undefined;
    let bestScore = 0;

    for (const entry of knowledgeBase) {
        let score = 0;
        for (const keyword of entry.keywords) {
            if (uniqueWords.has(keyword)) {
                score += 2;
            } else if (q.includes(keyword)) {
                score += 1;
            }
        }
        // prefer answers that match more of the question
        if (score > bestScore) {
            bestScore = score;
            best = entry;
        }
    }

    if (!best) {
        return { question, topic: "Companion", answer: "" };
    }

    return { question, topic: best.topic, answer: best.answer };
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { relaunch } from "@utils/native";
import { SettingsRouter } from "@webpack/common";

import { CompanionEntry,knowledgeBase } from "./knowledgeBase";

export const SUPPORT_INVITE = "https://discord.gg/n8rmQJRAzV";

export interface CompanionAction {
    id: string;
    /** Keywords that trigger this action (lowercase) */
    keywords: string[];
    /** What the companion says while doing it */
    reply: string;
    /** Run the action on the user's behalf */
    run(): void;
    /** Only available on the desktop app */
    desktopOnly?: boolean;
}

export const companionActions: CompanionAction[] = [
    {
        id: "open-settings",
        keywords: ["open", "settings", "preferences", "options"],
        reply: "On it — opening your Settings! ⚙️",
        run() {
            SettingsRouter.openUserSettings();
        }
    },
    {
        id: "open-plugins",
        keywords: ["open", "plugins", "plugin", "addons", "manager"],
        reply: "Opening the plugin panel for you! 🧩",
        run() {
            SettingsRouter.openUserSettings("limey_userplugins_panel");
        }
    },
    {
        id: "open-cloud",
        keywords: ["open", "cloud", "sync", "integrations", "settings"],
        reply: "Opening Cloud Integrations! ☁️",
        run() {
            SettingsRouter.openUserSettings("limeyV1_cloud_panel");
        }
    },
    {
        id: "restart",
        keywords: ["restart", "relaunch", "reload", "reboot", "reopen"],
        reply: "Restarting Discord for you — see you in a second! 🔄",
        desktopOnly: true,
        run() {
            relaunch();
        }
    },
    {
        id: "copy-invite",
        keywords: ["copy", "invite", "support", "server", "link"],
        reply: "Copied the support server invite to your clipboard! 📋",
        run() {
            copyToClipboard(SUPPORT_INVITE);
        }
    },
    {
        id: "open-download",
        keywords: ["download", "install", "website", "page", "browser"],
        reply: "Opening the Limey V1 download page! 🍋",
        run() {
            window.open("https://limey-discord.onrender.com/download", "_blank");
        }
    }
];

export interface CompanionReply {
    question: string;
    topic: CompanionEntry["topic"] | "Companion" | "Action";
    answer: string;
    /** Set when the companion performed (or is performing) an action on your behalf */
    action?: CompanionAction;
}

/**
 * Pick the best-matching predefined answer or action for a question.
 * Actions are matched first (they need stronger intent), then knowledge base
 * entries scored by keyword hits.
 */
export function askCompanion(question: string): CompanionReply {
    const q = question.toLowerCase();
    const uniqueWords = new Set(q.split(/\W+/).filter(Boolean));

    // 1. Actions: require an action verb AND an object keyword so we don't
    //    hijack plain questions like "what are plugins?"
    const verbs = ["open", "show", "launch", "start", "restart", "relaunch", "reload", "reboot", "copy", "download", "go", "take", "do"];
    let bestAction: CompanionAction | undefined;
    let bestActionScore = 0;
    for (const action of companionActions) {
        if (action.desktopOnly && IS_WEB) continue;
        const hasVerb = action.keywords.some(k => verbs.includes(k)) || uniqueWords.has(action.keywords[0]);
        if (!hasVerb) continue;
        let score = 0;
        for (const keyword of action.keywords) {
            if (uniqueWords.has(keyword)) score += 2;
            else if (q.includes(keyword)) score += 1;
        }
        if (score > bestActionScore) {
            bestActionScore = score;
            bestAction = action;
        }
    }

    if (bestAction && bestActionScore >= 3) {
        return { question, topic: "Action", answer: bestAction.reply, action: bestAction };
    }

    // 2. Knowledge base
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

/** Run a matched action and return what happened, for the chat bubble */
export function performAction(action: CompanionAction): string {
    try {
        action.run();
        return `${action.reply} ✅`;
    } catch (e) {
        return `${action.reply} …but it failed: ${String(e)}`;
    }
}

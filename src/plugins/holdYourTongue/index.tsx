/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "HoldYourTongue" by Kaan
 * (https://github.com/zrodevkaan/BDPlugins) — re-implemented natively
 * for Limey V1.
 *
 * Hooks into Discord's message-content warning filters (the same system
 * that shows the "@everyone" confirmation) to stop you from sending
 * messages containing your flagged keywords.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { mapMangledModuleLazy } from "@webpack";

// Discord's content-warning filter list (the module that also contains
// the "Everyone Warning" filter). One of its entries has a `check`
// function that runs on message send and can block it with a custom body.
const { warningFilters } = mapMangledModuleLazy("Everyone Warning", {
    warningFilters: m => Array.isArray(m) && m.some(x => x?.analyticsType != null)
});

interface Filter {
    analyticsType?: string;
    check?: (content: string) => { body: string } | false;
}

const NACHO_TYPE = "LimeyV1-hold-your-tongue";

const settings = definePluginSettings({
    keywords: {
        description: "Keywords to watch for (one per line)",
        type: OptionType.STRING,
        multiline: true,
        default: "lipton green tea citrus"
    },
    body: {
        description: "Halt message. Use {words} where flagged words go",
        type: OptionType.STRING,
        multiline: true,
        default: "Woah there! You are about to send some keywords you don't want to send. e.g. {words}"
    }
});

function getKeywords(): string[] {
    return settings.store.keywords
        .split("\n")
        .map(k => k.trim())
        .filter(Boolean);
}

function check(content: string): { body: string } | false {
    const lower = content.toLowerCase();
    const found = getKeywords().filter(keyword => lower.includes(keyword.toLowerCase()));
    if (found.length === 0) return false;
    return {
        body: settings.store.body.replace("{words}", found.join(", "))
    };
}

export default definePlugin({
    name: "HoldYourTongue",
    description: "Stop yourself from saying things in chat! Blocks sending messages that contain your flagged keywords",
    authors: [Devs.Limey],
    settings,

    patches: [],

    start() {
        const filters = warningFilters as Filter[];
        const existing = filters.find(f => f.analyticsType === NACHO_TYPE);
        if (existing) {
            existing.check = check;
        } else {
            filters.push({ analyticsType: NACHO_TYPE, check });
        }
    },

    stop() {
        const filters = warningFilters as Filter[];
        const index = filters.findIndex(f => f.analyticsType === NACHO_TYPE);
        if (index !== -1) filters.splice(index, 1);
    },
});

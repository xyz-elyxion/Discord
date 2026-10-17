/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Scam signatures ported from the server's AutoMod rules, kept byte-for-byte
 * compatible so client-side flags pick up exactly what AutoMod would have
 * caught. Server rules keep the repo in sync when new patterns are added.
 */

export interface ScamPattern {
    /** Short human-readable tag shown in toasts, tool tips and the console */
    name: string;
    regex: RegExp;
    /** Exempt a bare genuine steamcommunity.com spelling for this rule
     *  (the mimic-domain rule also matches the real domain). Redirect,
     *  markdown and shortener wrappers still flag — those carry other rules. */
    allowGenuineSteamcommunity?: boolean;
}

/**
 * Regex rules from AutoMod — matched against the raw message content,
 * case-insensitive.
 */
export const SCAM_PATTERNS: ScamPattern[] = [
    {
        name: "Sexual invite bait",
        regex: /(nude(s|z)?|teen(s|z)?|sex|porn|xxx|leak(s|z)?|onlyfans|tiktok|🔞).*\n*(https:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/i
    },
    {
        name: "Invite link with scam keywords",
        regex: /(https:\/\/)?(discord\.gg\/|discord\.com\/invite\/)(.){0,8}(nude(s|z)?|teen(s|z)?|sex|porn|xxx|leak(s|z)?|onlyfans|tiktok)/i
    },
    {
        name: "Fake roblox markdown link (shrturl.biz)",
        regex: /roblox\.com\/users\/1.*]\(https:\/\/shrturl\.biz/i
    },
    {
        name: "Steam markdown link via redirect shortener",
        regex: /steamcommunity\.com\/.*\]\(https:\/\/(exi\.link|sc\.link|bit\.ly|u\.to|cutt\.ly|udhdh\.site|qptr\.ru|bitly\.cx|envs\.sh|shorturl\.at|gg\.gg|hurlurl\.com|t\.ly)/i
    },
    {
        name: "Steam/gift payout with a link",
        regex: /(\$.*steam|\$.*gift).*\s(http(s?):\/\/st)/i
    },
    {
        name: "Steam/gift with markdown link",
        regex: /(\$|steam|gift).*\s(\[steam.*\]\(.*\))/i
    },
    {
        name: "4+ fake image attachments",
        regex: /(.*\.discordapp\.(net|com)\/attachments\/[0-9]{18,19}\/[0-9]{18,19}\/([1-4]|image)\.(png|jpg).*\s*){4}/i
    },
    {
        name: "Mimic-domain link",
        regex: /https:\/\/s[ctz]y?[ace][aemnu][a-z]{1,4}o[mn][a-z]{4,8}[iy][a-z]?\.com\//i,
        allowGenuineSteamcommunity: true
    },
];

/**
 * Phrases AutoMod watches as plain keywords. The leading/trailing `*` blobs in
 * those rules are wildcards, so each entry matches as a case-insensitive
 * substring anywhere in the message.
 */
export const SCAM_PHRASES: string[] = [
    "check my bi0",
    "check my bio 😁",
    "girl in cam",
    "https://steamcomumnity.com/",
    "https://u.to/i1YTIQ",
    "https://www.roblox.com.kg",
    "is in cam naked",
    "join girl in cam",
    "media.discordapp.net/attachments/1294380382661116045/",
    "on cam look",
    "she in cam look",
    "she's squirting",
    "steamcommunity.com/gift",
    "stenmcommnunnity.com",
    "wtf this girl doing",
];

/**
 * The public scam-report policy allows plain https://steamcommunity.com/…
 * links: they are exempted from the mimic-domain rule (only) by testing the
 * same regex with genuine steamcommunity occurrences neutralised. Typo
 * squats ("steamcomumnity", "stenmcommnunnity", …) do not contain the exact
 * genuine spelling, so they still flag.
 */
function withoutGenuineSteamcommunity(text: string): string {
    return text.replace(/steamcommunity/gi, "steam community");
}

export interface ScamResult {
    /** True when the content matches anything flagged */
    scam: boolean;
    /** Names of every pattern that caught it, for the UI tooltip */
    rules: string[];
}

/** A bare steamcommunity.com link with no redirect wrapper is allowed */
export const ALLOW_PLAIN_STEAMCOMMUNITY = true;

export function formatMatchedRules(rules: string[]): string {
    return rules.join(", ");
}

export function scamMatch(content: string | undefined | null): ScamResult {
    const rules: string[] = [];
    if (typeof content !== "string" || !content) return { scam: false, rules };

    const text = content;

    let hasGenuineSteam = false;
    for (const { name, regex, allowGenuineSteamcommunity } of SCAM_PATTERNS) {
        if (!regex.test(text)) continue;
        if (allowGenuineSteamcommunity) {
            const wrappedMatch = regex.test(withoutGenuineSteamcommunity(text));
            if (!wrappedMatch) {
                hasGenuineSteam = true;
                continue;
            }
        }
        rules.push(name);
    }
    if (rules.length === 0 && !hasGenuineSteam) {
        const lower = text.toLowerCase();
        for (const phrase of SCAM_PHRASES) {
            if (lower.includes(phrase.toLowerCase())) {
                rules.push(`Phrase: "${phrase}"`);
            }
        }
    }

    return { scam: rules.length > 0, rules };
}

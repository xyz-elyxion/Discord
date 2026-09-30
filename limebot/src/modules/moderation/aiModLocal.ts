/**
 * Local analysis engine for AI Mod — no external API required.
 *
 * Implements the same four-axis judgment (intent, target, evidence,
 * escalation risk) as the LLM policy, using weighted heuristics:
 * normalization-resistant matching (leetspeak, spacing, homoglyphs),
 * intent classifiers, link/evidence inspection, and severity scoring
 * across all four verdicts.
 */

import type { Verdict } from "./aiMod";

export interface LocalClassification {
    verdict: Verdict;
    reason: string;
    confidence: number;
}

// ---- Normalization (defeats obfuscation) -------------------------------------

/** common homoglyph/leet map */
const GLYPH_MAP: Record<string, string> = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b",
    "@": "a", "$": "s", "!": "i", "|": "l", "€": "e", "£": "l", "+": "t",
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", // cyrillic homoglyphs
};

function normalize(text: string): string {
    let out = "";
    for (const ch of text.toLowerCase()) {
        out += GLYPH_MAP[ch] ?? ch;
    }
    // collapse letter-spacing obfuscation ("f r e e   n i t r o")
    return out.replace(/([a-z]) (?=[a-z]( |$))/g, "$1").replace(/\s+/g, " ");
}

// ---- Lexicons -----------------------------------------------------------------

const THREAT_PATTERNS = [
    /\b(?:i(?:'| a)?m|im|we(?:'| a)?re|going to|gonna|will)\s+(?:kill|murder|hurt|find you|end you|beat( you)? up|come to your house)/,
    /\b(?:kill yourself|kys|go die|hanging yourself)\b/,
    /\bi (?:know|have) your (?:address|ip|home|school|family)\b/,
    /\bdox(?:ing|ed)? you\b/,
];

const SLURS = [
    "faggot", "f4ggot", "n1gger", "nigger", "nigga", "retard", "tranny",
    "kike", "chink", "spic", "wetback", "towelhead", "raghead"
];

const SCAM_PATTERNS = [
    /\bfree\s+(?:nitro|discord nitro|robux|vbucks|skins|gift)\b/,
    /\b(?:nitro|steam|roblox)\s*(?:gift|gen(?:erator)?|boost)\b.*\b(?:free|claim|redeem)\b/,
    /\bclaim(?:ed)? your (?:prize|reward|gift)\b/,
    /\byou(?:'ve)? (?:been )?(?:selected|won|chosen)\b/,
    /\bfirst \d+ (?:people|users) (?:get|win)\b/,
    /\bselling (?:cheap|discount) (?:nitro|accounts)\b/,
    /\bdiscord\.gift|\bgift\.dis\w*\b/,
    /\bsteamcomunity\b|\bdiscorda?pp\.gift\b|\bdiscord-?nitro\.\w+\b/,
    /\b(?:i'?m|i am) (?:leaving|quitting) discord\b.*\b(?:free|gift)\b/,
    /\bairdrop\b.*\b(?:crypto|usdt|btc|eth)\b/i,
    /\bdouble your (?:money|crypto)\b/,
];

const MALWARE_SIGNS = [
    /\.exe\b|\.scr\b|\.bat\b|\.cmd\b|\.msi\b|\.apk\b|\.jar\b/i,
    /\bremote (?:access|control) (?:tool|software)|rat\b/i,
    /\btoken (?:grabber|stealer|logger)\b/i,
    /\bssfn\b|\bself-?xss\b|\bhack(?:ed)? (?:account|server)\b/i,
    /\bdownload(?:ed)? this (?:tool|file|program|app) to\b/i,
    /\bdisable (?:your )?(?:antivirus|defender)\b/i,
];

const PHISHING_DOMAINS = [
    /steamcom?mu?nity/i, /discor[dln]/i, /giveaway/i, /nitro/i, /d1scord/i,
];

const INVITE_REGEX = /discord(?:app)?\.(?:gg|com\/invite|io)\/[\w-]+/i;
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

const NSFW_PATTERNS = [
    /\b(?:nudes|n00ds|send (?:me )?(?:nudes|boobs|tits))\b/,
    /\b(?:penis|vagina|cum|jizz|horny|milf|hentai)\b/,
    /\b(?:porn|pornhub|rule34|e621)\b/,
    /\brape\b|\bmolest\b/,
];

const HARASSMENT_PATTERNS = [
    /\b(?:shut (?:the fuck )?up|no one likes you|kill yourself|you'?re (?:worthless|useless|trash))\b/,
    /\bstfu\s+(?:you\s+)?(?:dumb|stupid|fat|ugly)\b/,
];

const SELF_HARM_PATTERNS = [
    /\b(?:cut(?:ting)? myself|i want to die|i wanna die|suicidal|end it all)\b/,
];

// Channels/topics that are effectively noise — not violations
const BENIGN_SIGNS = [
    /\b(?:thanks|thank you|ty|nice|cool|awesome|good|great|lol|lmao|haha|lmfao|bro|dude)\b/,
    /\?+$/, // questions are usually genuine
];

// ---- Scoring --------------------------------------------------------------------

export function classifyLocally(rawContent: string): LocalClassification {
    const content = rawContent;
    const norm = normalize(content);
    const lower = content.toLowerCase();

    const reasons: string[] = [];
    let severity = 0; // 0 = ok … 1 = ban threshold
    let confidence = 0.5;

    // --- Axis 3: EVIDENCE — links & files ---------------------------------------
    const urls = content.match(URL_REGEX) ?? [];
    const hasInvite = INVITE_REGEX.test(content);

    for (const pattern of MALWARE_SIGNS) {
        if (pattern.test(norm) || pattern.test(content)) {
            severity += 0.55;
            confidence += 0.15;
            reasons.push("malware/hacking-related content");
            break;
        }
    }

    for (const pattern of SCAM_PATTERNS) {
        if (pattern.test(norm) || pattern.test(content)) {
            severity += 0.5;
            confidence += 0.15;
            reasons.push("scam/phishing content");
            break;
        }
    }

    // suspicious domain look-alikes
    for (const url of urls) {
        try {
            const host = new URL(url).hostname;
            for (const p of PHISHING_DOMAINS) {
                if (p.test(host) && !/^(?:www\.)?(?:discord\.com|steamcommunity\.com|steampowered\.com)$/.test(host)) {
                    // domain mentions "discord"/"nitro"/"steam" but isn't the real one
                    if (!/(?:^|\.)(?:discord\.gg|discord\.com|discordapp\.com|steamcommunity\.com|steampowered\.com)$/.test(host)) {
                        severity += 0.45;
                        confidence += 0.1;
                        reasons.push(`look-alike phishing domain (${host})`);
                    }
                    break;
                }
            }
        } catch { /* not a valid url */ }
    }

    if (hasInvite) {
        severity += 0.3;
        reasons.push("server invite (advertising)");
    }

    // --- Axis 1 & 2: INTENT & TARGET ----------------------------------------------

    for (const pattern of THREAT_PATTERNS) {
        if (pattern.test(norm) || pattern.test(lower)) {
            severity += 0.85;
            confidence += 0.2;
            reasons.push("credible threat / targeted harm");
            break;
        }
    }

    for (const slur of SLURS) {
        if (norm.includes(slur)) {
            severity += 0.5;
            confidence += 0.15;
            reasons.push("slur / hate speech");
            break;
        }
    }

    for (const pattern of HARASSMENT_PATTERNS) {
        if (pattern.test(norm)) {
            severity += 0.35;
            confidence += 0.1;
            reasons.push("harassment / targeted abuse");
            break;
        }
    }

    for (const pattern of NSFW_PATTERNS) {
        if (pattern.test(norm)) {
            severity += 0.4;
            confidence += 0.1;
            reasons.push("sexual / explicit content");
            break;
        }
    }

    for (const pattern of SELF_HARM_PATTERNS) {
        if (pattern.test(norm)) {
            // never punish — this needs human care, not a mute
            return {
                verdict: "ok",
                reason: "possible self-harm mention — flagged for staff review, no action taken",
                confidence: 0.6,
            };
        }
    }

    // --- Mild issues ----------------------------------------------------------------
    // all-caps shouting
    const letters = content.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 24 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.8) {
        severity += 0.12;
        reasons.push("excessive caps");
    }

    // spam: repeated chars / repeated message shape
    if (/(.)\1{9,}/.test(content)) {
        severity += 0.15;
        reasons.push("character spam");
    }

    // benign signals pull severity down (avoid punishing banter)
    const benignHits = BENIGN_SIGNS.filter(p => p.test(lower)).length;
    if (benignHits && severity < 0.4) {
        severity *= 0.55;
        confidence -= 0.05;
    }

    // clamp
    severity = Math.max(0, Math.min(1, severity));
    confidence = Math.max(0.3, Math.min(0.95, confidence));

    // --- Map severity to verdict (the four-axis judgment, distilled) ---------------
    let verdict: Verdict = "ok";
    if (severity >= 0.8) verdict = "ban";
    else if (severity >= 0.45) verdict = "mute";
    else if (severity >= 0.18) verdict = "warn";

    if (verdict === "ok") {
        return { verdict: "ok", reason: "no policy violation detected", confidence: 0.6 + (benignHits ? 0.1 : 0) };
    }

    return {
        verdict,
        reason: reasons.slice(0, 3).join("; ") || "policy violation",
        confidence,
    };
}

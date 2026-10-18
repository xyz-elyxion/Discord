/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Discord snowflake epoch (2015-01-01T00:00:00.000Z) */
export const DISCORD_EPOCH = 1420070400000n;

/** How long a cached analysis stays fresh before it needs re-fetching */
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Supported badge ids on Discord profiles */
export const BADGE_LABELS: Record<string, string> = {
    HypeSquadOnlineHouses: "HypeSquad (Online House)",
    HypeSquadBravery: "HypeSquad Bravery",
    HypeSquadBrilliance: "HypeSquad Brilliance",
    HypeSquadBalance: "HypeSquad Balance",
    HypeSquadEvents: "HypeSquad Events",
    EarlySupporter: "Early Supporter",
    VerifiedBot: "Verified Bot",
    VerifiedDeveloper: "Verified Developer",
    Partner: "Partner",
    Staff: "Staff",
    BugHunterLevel1: "Bug Hunter",
    BugHunterLevel2: "Bug Hunter Gold",
    ActiveDeveloper: "Active Developer",
    PremiumEarlySupporter: "Early Supporter",
    EarlyVerifiedBotDeveloper: "Early Verified Bot Developer",
};

/** These badges can no longer be obtained — strong signal that the account is old / genuine */
export const EXPIRED_BADGE_IDS = new Set([
    "EarlySupporter",
    "PremiumEarlySupporter",
    "HypeSquadOnlineHouses",
    "HypeSquadBravery",
    "HypeSquadBrilliance",
    "HypeSquadBalance",
    "HypeSquadEvents",
    "EarlyVerifiedBotDeveloper",
]);

/** How much having specific flags is worth for the score capped-rate box. */
export const FLAG_WEIGHTS: Record<string, number> = {
    VerifiedBot: 45,
    VerifiedDeveloper: 35,
    BugHunterLevel2: 30,
    Partner: 25,
    Staff: 45,
    BugHunterLevel1: 20,
    ActiveDeveloper: 20,
    EarlyVerifiedBotDeveloper: 40,
    HypeSquadOnlineHouses: 15,
    EarlySupporter: 15,
    PremiumEarlySupporter: 15,
    HypeSquadBravery: 15,
    HypeSquadBrilliance: 15,
    HypeSquadBalance: 15,
    HypeSquadEvents: 15,
};

/** Weights for the "account quality score" (0-100) */
export const SCORE_WEIGHTS = {
    ageDaysPerYear: 4, // 4 points per full year of age, capped
    badgePoints: 6, // per badge, capped
    expiredBadgeBonus: 4, // per unobtainable badge, capped
    nitroPoints: 20, // having nitro at all
    bannerPoints: 10, // having a profile banner
    bioPoints: 5, // populating a bio / about me
    decorationPoints: 5, // wearing an avatar decoration
    pronounsPoints: 2,
    clanPoints: 5, // being in a clan/guild tag
    connectionPoints: 2, // per linked account, capped
    maxScore: 100
};

/** What the score bands mean, used for the fingerprint emoji summary */
export const SCORE_BANDS = [
    { min: 0, label: "Sus?", emoji: "🚩", color: "#ed4245", note: "Very thin account — treat with caution." },
    { min: 25, label: "Thin", emoji: "🤏", color: "#faa61a", note: "Little profile investment. Could be an alt, or just a lurker." },
    { min: 50, label: "Average", emoji: "🙂", color: "#faa61a", note: "A normal, moderately invested account." },
    { min: 75, label: "Solid", emoji: "💪", color: "#3ba55c", note: "Looks well-established and invested." },
    { min: 90, label: "Veteran", emoji: "🏅", color: "#3ba55c", note: "Aged, decorated account — high trust." },
];

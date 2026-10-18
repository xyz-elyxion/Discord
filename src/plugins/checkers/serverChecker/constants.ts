/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Discord snowflake epoch (2015-01-01T00:00:00.000Z) */
export const DISCORD_EPOCH = 1420070400000n;

/** How long a cached analysis stays fresh before it needs re-fetching */
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Guild features that carry trust weight — hard to obtain, tied to moderation or verification */
export const TRUST_FEATURES = new Set([
    "VERIFIED",
    "PARTNERED",
    "DISCOVERABLE",
    "FEATURABLE",
    "COMMUNITY",
    "AUTO_MODERATION",
    "MEMBER_VERIFICATION_GATE_ENABLED",
    "MEMBER_VERIFICATION_MANUAL_APPROVAL",
    "GUILD_ONBOARDING",
    "WELCOME_SCREEN_ENABLED",
    "ROLE_ICONS",
    "NEWS",
    "NON_COMMUNITY_RAID_ALERTS",
    "REPORT_TO_MOD_PILOT",
]);

/** Bait-heavy feature set — marks servers that sell themselves (often legit, sometimes scam fronts) */
export const COMMERCE_FEATURES = new Set([
    "COMMERCE",
    "CREATOR_MONETIZABLE",
    "CREATOR_MONETIZABLE_PROVISIONAL",
    "ROLE_SUBSCRIPTIONS_ENABLED",
    "PRODUCTS_AVAILABLE_FOR_PURCHASE",
    "SOCIAL_LAYER_STOREFRONT",
    "CLAN",
    "GUILD_TAGS",
]);

/** What the score bands mean, matches Account Checker's language so both tools feel alike */
export const SCORE_BANDS = [
    { min: 0, label: "Sketchy?", emoji: "🚩", color: "#ed4245", note: "Very thin or fresh server — treat with caution." },
    { min: 25, label: "Small", emoji: "🤏", color: "#faa61a", note: "A new or tiny server. Not automatically bad, but nothing proves it yet." },
    { min: 50, label: "Average", emoji: "🙂", color: "#faa61a", note: "A normal, moderately moderated server." },
    { min: 75, label: "Solid", emoji: "💪", color: "#3ba55c", note: "Looks well-established with real moderation tooling." },
    { min: 90, label: "Flagship", emoji: "🏅", color: "#3ba55c", note: "Verified/discoverable server with a long history — high trust." },
];

/** Weights used to keep the score predictable (see computeScore-style sum in analysis.ts) */
export const SCORE_WEIGHTS = {
    ageDaysPerYear: 5, // per full year old, capped
    ageCap: 25,
    boostPoints: 2, // per boost, capped
    boostCap: 18,
    tier3Bonus: 8,
    trustFeaturePoints: 4, // per trust feature, capped
    trustFeatureCap: 24,
    welcomePoints: 4,
    onboardingPoints: 4,
    automodPoints: 6,
    raidAlertPoints: 4,
    nsfwPenalty: -12,
    explicitFilterPoints: [0, 4, 8], // explicitContentFilter 0..2
    verificationPoints: [0, 3, 6, 9, 12], // verificationLevel 0..4
    maxScore: 100,
};

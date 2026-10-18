/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { EmojiStore, GuildStore, StickersStore } from "@webpack/common";

import { CACHE_TTL_MS, COMMERCE_FEATURES, DISCORD_EPOCH, SCORE_BANDS, SCORE_WEIGHTS, TRUST_FEATURES } from "./constants";

/**
 * Invite-fetcher, resolves lazily at plugin load (WebpackReady) time so invites
 * can be re-analysed even if the server isn't joined yet.
 */
const inviteFetcher = findByPropsLazy("resolveInvite") as {
    resolveInvite: (code: string, includeRelationshipData: boolean) => Promise<unknown>;
};

export interface GuildCheckResult {
    id: string;
    label: string;
    note: string;
    level: "pass" | "warn" | "neutral";
    points: number;
}

export interface GuildAnalysis {
    guildId: string;
    name: string;
    /** Creation date derived from the snowflake */
    createdAt: number;
    createdAtLabel: string;
    ageDays: number;
    /** true when this server was analysed from a joined guild; false from an invite */
    joined: boolean;
    description: string | null;
    verificationLevel: number;
    nsfwLevel: number;
    explicitContentFilter: number;
    boostCount: number;
    premiumTier: number;
    trustFeatures: string[];
    commerceFeatures: string[];
    emojiCount: number;
    stickerCount: number;
    /** undefined when no member data is available */
    approximateMemberCount?: number;
    checks: GuildCheckResult[];
    score: number;
    bandIndex: number;
    partial: boolean;
}

export function getBand(score: number): (typeof SCORE_BANDS)[number] {
    return SCORE_BANDS.reduce((acc, band) => (score >= band.min ? band : acc), SCORE_BANDS[0]);
}

export function guildAgeFromSnowflake(id: string) {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

const listeners = new Set<() => void>();
const cache = new Map<string, { analysis: GuildAnalysis; fetchedAt: number; }>();
const pending = new Set<string>();
const inflight = new Map<string, Promise<GuildAnalysis | null>>();

function notify() {
    for (const l of listeners) l();
}

export function subscribeAnalysis(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function getCachedAnalysis(guildId: string | undefined) {
    return guildId ? cache.get(guildId)?.analysis : undefined;
}

export function isAnalyzing(guildId: string | undefined) {
    return !!guildId && pending.has(guildId);
}

export function invalidateAnalysis() {
    cache.clear();
    notify();
}

const VERIFICATION_LABELS = ["None", "Low", "Medium", "High", "Highest"];
const NSFW_LABELS = ["Default", "Explicit", "Safe", "Age-Restricted"];

function trustCommerceSplit(features: Set<string> | string[] | undefined) {
    const list = features ? Array.from(features) : [];
    return {
        trust: list.filter(f => TRUST_FEATURES.has(f)),
        commerce: list.filter(f => COMMERCE_FEATURES.has(f)),
        all: list,
    };
}

export async function analyzeGuild(guildId: string): Promise<GuildAnalysis | null> {
    const fresh = cache.get(guildId);
    if (fresh && Date.now() - fresh.fetchedAt < CACHE_TTL_MS) return fresh.analysis;

    const running = inflight.get(guildId);
    if (running) return running;

    const job = (async () => {
        const guild = GuildStore.getGuild(guildId);
        if (!guild) return null;

        const createdAt = guildAgeFromSnowflake(guildId);
        const ageDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86_400_000));
        const { trust: trustFeatures, commerce: commerceFeatures } = trustCommerceSplit(guild.features as unknown as Set<string>);

        let emojiCount = 0;
        let stickerCount = 0;
        try {
            emojiCount = (EmojiStore.getGuildEmoji?.(guildId) as any[] | undefined)?.length ?? 0;
        } catch { /* store unavailable */ }
        try {
            stickerCount = (StickersStore.getStickersByGuildId?.(guildId) as any[] | undefined)?.length ?? 0;
        } catch { /* store unavailable */ }

        const boostCount = guild.premiumSubscriberCount ?? 0;
        const premiumTier = guild.premiumTier ?? 0;
        const verificationLevel = guild.verificationLevel ?? 0;
        const nsfwLevel = guild.nsfwLevel ?? 0;
        const explicitContentFilter = guild.explicitContentFilter ?? 0;

        const checks: GuildCheckResult[] = [];

        // -- Age (primary trust signal) -----------------------------------------
        const olderThan90 = ageDays >= 90;
        const olderThanYear = ageDays >= 365;
        checks.push({
            id: "age-90",
            label: "Older than 90 days",
            note: olderThan90
                ? `Created ${createdAt.toLocaleDateString()} — ${ageDays} days old.`
                : "Fresh server — most scam servers get made and burn in under a week.",
            level: olderThan90 ? "pass" : "warn",
            points: Math.min(Math.floor(ageDays / 30) * 2, 10),
        });
        checks.push({
            id: "age-1y",
            label: "Older than a year",
            note: olderThanYear
                ? `${Math.floor(ageDays / 365)} year(s) of history — long-lived servers rarely turn out to be scams.`
                : "Under a year old — nothing to verify from age yet.",
            level: olderThanYear ? "pass" : "neutral",
            points: olderThanYear ? 8 : 0,
        });

        // -- Verification / moderation ------------------------------------------
        checks.push({
            id: "verification-level",
            label: "Verification level",
            note: verificationLevel >= 3
                ? "High/Highest — new members must wait or be approved, classic safe-server behavior."
                : `Only "${VERIFICATION_LABELS[verificationLevel] ?? "?"}" — slack join tools, easy raid vector.`,
            level: verificationLevel >= 3 ? "pass" : verificationLevel === 0 ? "warn" : "neutral",
            points: SCORE_WEIGHTS.verificationPoints[verificationLevel] ?? 0,
        });
        checks.push({
            id: "explicit-filter",
            label: "Content filter",
            note: explicitContentFilter >= 2
                ? "Scans every message — strong anti-scam baseline."
                : explicitContentFilter === 0
                    ? "No automatic content scanning at all."
                    : "Scans members without a role only.",
            level: explicitContentFilter >= 2 ? "pass" : explicitContentFilter === 0 ? "warn" : "neutral",
            points: SCORE_WEIGHTS.explicitFilterPoints[explicitContentFilter] ?? 0,
        });
        const hasAutomod = trustFeatures.includes("AUTO_MODERATION");
        checks.push({
            id: "automod",
            label: "AutoMod",
            note: hasAutomod
                ? "AutoMod enabled — server actively stops scam links at the door."
                : "No AutoMod — scam links flow in unchecked (default for most small servers).",
            level: hasAutomod ? "pass" : "neutral",
            points: hasAutomod ? SCORE_WEIGHTS.automodPoints : 0,
        });
        const hasRaidAlerts = trustFeatures.includes("NON_COMMUNITY_RAID_ALERTS");
        checks.push({
            id: "raid-alerts",
            label: "Raid alerts",
            note: hasRaidAlerts
                ? "Server has raid alert tooling turned on."
                : "No raid alerts enabled.",
            level: hasRaidAlerts ? "pass" : "neutral",
            points: hasRaidAlerts ? SCORE_WEIGHTS.raidAlertPoints : 0,
        });

        // -- Community investment ------------------------------------------------
        const hasWelcome = trustFeatures.includes("WELCOME_SCREEN_ENABLED");
        const hasOnboarding = trustFeatures.includes("GUILD_ONBOARDING");
        checks.push({
            id: "welcome-onboarding",
            label: "Welcome screen / onboarding",
            note: hasOnboarding
                ? "Full onboarding flow — effort put into new member experience."
                : hasWelcome
                    ? "Welcome screen enabled — some new-member setup."
                    : "No welcome screen or onboarding — default join flow.",
            level: hasOnboarding ? "pass" : hasWelcome ? "pass" : "neutral",
            points: (hasOnboarding ? SCORE_WEIGHTS.onboardingPoints : 0) + (hasWelcome ? SCORE_WEIGHTS.welcomePoints : 0),
        });

        // -- Trust features ------------------------------------------------------
        checks.push({
            id: "trust-features",
            label: "Trust features",
            note: trustFeatures.length
                ? `${trustFeatures.length} trust feature(s): ${trustFeatures.join(", ")}.`
                : "No hard-to-get features (Verified/Partnered/Discoverable…) on this server.",
            level: trustFeatures.length >= 4 ? "pass" : trustFeatures.length > 0 ? "neutral" : "neutral",
            points: Math.min(trustFeatures.length * SCORE_WEIGHTS.trustFeaturePoints, SCORE_WEIGHTS.trustFeatureCap),
        });
        const verified = trustFeatures.includes("VERIFIED");
        const partnered = trustFeatures.includes("PARTNERED");
        checks.push({
            id: "verified-partnered",
            label: "Verified / Partnered",
            note: verified || partnered
                ? verified
                    ? "The Discord-verified checkmark — strongest server trust signal there is."
                    : "Partnered server — vetted by Discord's partner program."
                : "No Verified / Partnered badge — expected for the vast majority of servers.",
            level: verified || partnered ? "pass" : "neutral",
            points: (verified || partnered) ? 12 : 0,
        });

        // -- NSFW ----------------------------------------------------------------
        const isExplicit = nsfwLevel === 1 || nsfwLevel === 3; // Explicit or Age-Restricted
        checks.push({
            id: "nsfw",
            label: "NSFW level",
            note: isExplicit
                ? `Marked "${NSFW_LABELS[nsfwLevel] ?? "?"}" — adult content server, expect links that get users in trouble.`
                : `Marked "${NSFW_LABELS[nsfwLevel] ?? "?"}" — no special age gating.`,
            level: isExplicit ? "warn" : "neutral",
            points: isExplicit ? SCORE_WEIGHTS.nsfwPenalty : 0,
        });

        // -- Commerce / monetized ------------------------------------------------
        checks.push({
            id: "commerce",
            label: "Commerce / monetization",
            note: commerceFeatures.length
                ? `Monetization active (${commerceFeatures.join(", ")}) — real money flows here, extra care advised.`
                : "No commerce features — outside the usual \"drop free Nitro\" scam profile.",
            level: commerceFeatures.length ? "neutral" : "pass",
            points: commerceFeatures.length ? 0 : 4,
        });

        // -- Boosts --------------------------------------------------------------
        checks.push({
            id: "boosts",
            label: "Server boosts",
            note: premiumTier === 3
                ? `Level 3 with ${boostCount} boosts — thousands of paid months of investment.`
                : boostCount > 0
                    ? `${boostCount} boost(s) (Level ${premiumTier}) — genuine members spend on this server.`
                    : "No boosts — free account usage only.",
            level: boostCount >= 7 ? "pass" : boostCount > 0 ? "neutral" : "neutral",
            points: Math.min(boostCount * SCORE_WEIGHTS.boostPoints, SCORE_WEIGHTS.boostCap) + (premiumTier === 3 ? SCORE_WEIGHTS.tier3Bonus : 0),
        });

        // -- Cultural size -------------------------------------------------------
        checks.push({
            id: "culture",
            label: "Emoji / stickers",
            note: emojiCount + stickerCount > 0
                ? `${emojiCount} emoji and ${stickerCount} sticker(s) — members contribute culture over time.`
                : "No custom emoji or stickers — brand-new or dormant server.",
            level: emojiCount + stickerCount > 20 ? "pass" : emojiCount + stickerCount > 0 ? "neutral" : "warn",
            points: Math.min(emojiCount + stickerCount, 4),
        });

        // Total up score, clamped 0-100
        const totalFromChecks = checks.reduce((acc, c) => acc + c.points, 0);
        const score = Math.max(0, Math.min(100, Math.round(totalFromChecks)));

        const analysis: GuildAnalysis = {
            guildId,
            name: guild.name,
            createdAt: createdAt.getTime(),
            createdAtLabel: createdAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
            ageDays,
            joined: true,
            description: guild.description ?? null,
            verificationLevel,
            nsfwLevel,
            explicitContentFilter,
            boostCount,
            premiumTier,
            trustFeatures,
            commerceFeatures,
            emojiCount,
            stickerCount,
            checks,
            score,
            bandIndex: SCORE_BANDS.indexOf(getBand(score)),
            partial: false,
        };

        cache.set(guildId, { analysis, fetchedAt: Date.now() });
        return analysis;
    })();

    pending.add(guildId);
    inflight.set(guildId, job);
    notify();

    try {
        const result = await job;
        return result;
    } finally {
        pending.delete(guildId);
        inflight.delete(guildId);
        notify();
    }
}

/** Resolve an invite code into an in-memory "ghost" guild analysis without joining */
export async function analyzeInvite(code: string): Promise<GuildAnalysis | null> {
    const running = inflight.get(code);
    if (running) return running;

    const job = (async (): Promise<GuildAnalysis | null> => {
        try {
            const resolved = (await inviteFetcher.resolveInvite(code, false)) as any;
            const guild = resolved?.invite?.guild ?? resolved?.guild;
            if (!guild) return null;
            return summarizeInviteGuild(guild);
        } catch {
            return null;
        }
    })();

    pending.add(code);
    inflight.set(code, job);
    notify();
    try {
        return await job;
    } finally {
        pending.delete(code);
        inflight.delete(code);
        notify();
    }
}

/** Invite payloads look like Guild-with-fewer-fields, so we share the same checks */
function summarizeInviteGuild(inviteGuild: any): GuildAnalysis | null {
    if (!inviteGuild?.id) return null;
    const guildId = inviteGuild.id as string;
    const createdAt = guildAgeFromSnowflake(guildId);
    const ageDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86_400_000));
    const { trust: trustFeatures, commerce: commerceFeatures } = trustCommerceSplit(inviteGuild.features as Set<string>);
    const boostCount = inviteGuild.premiumSubscriberCount ?? 0;
    const premiumTier = inviteGuild.premiumTier ?? 0;
    const verificationLevel = inviteGuild.verificationLevel ?? 0;
    const nsfwLevel = inviteGuild.nsfwLevel ?? 0;
    const checks: GuildCheckResult[] = [];

    const olderThan90 = ageDays >= 90;
    const olderThanYear = ageDays >= 365;
    checks.push({
        id: "age-90",
        label: "Older than 90 days",
        note: olderThan90
            ? `Created ${createdAt.toLocaleDateString()} — ${ageDays} days old.`
            : "Fresh server — most scam servers die fast.",
        level: olderThan90 ? "pass" : "warn",
        points: Math.min(Math.floor(ageDays / 30) * 2, 10),
    });
    checks.push({
        id: "age-1y",
        label: "Older than a year",
        note: olderThanYear ? `${Math.floor(ageDays / 365)} year(s) of history.` : "Under a year old.",
        level: olderThanYear ? "pass" : "neutral",
        points: olderThanYear ? 8 : 0,
    });
    checks.push({
        id: "verification-level",
        label: "Verification level",
        note: verificationLevel >= 3 ? "High/Highest — vetted join flow." : `Only "${VERIFICATION_LABELS[verificationLevel] ?? "?"}".`,
        level: verificationLevel >= 3 ? "pass" : verificationLevel === 0 ? "warn" : "neutral",
        points: SCORE_WEIGHTS.verificationPoints[verificationLevel] ?? 0,
    });
    checks.push({
        id: "trust-features",
        label: "Trust features",
        note: trustFeatures.length
            ? `${trustFeatures.length} trust feature(s): ${trustFeatures.join(", ")}.`
            : "No hard-to-get features.",
        level: trustFeatures.length >= 4 ? "pass" : "neutral",
        points: Math.min(trustFeatures.length * SCORE_WEIGHTS.trustFeaturePoints, SCORE_WEIGHTS.trustFeatureCap),
    });
    const verified = trustFeatures.includes("VERIFIED");
    const partnered = trustFeatures.includes("PARTNERED");
    checks.push({
        id: "verified-partnered",
        label: "Verified / Partnered",
        note: verified ? "Discord-verified server." : partnered ? "Partnered server." : "Not verified / partnered — expected for most servers.",
        level: verified || partnered ? "pass" : "neutral",
        points: (verified || partnered) ? 12 : 0,
    });
    checks.push({
        id: "boosts",
        label: "Server boosts",
        note: premiumTier === 3 ? `Level 3 with ${boostCount} boosts.` : boostCount > 0 ? `${boostCount} boost(s).` : "No boosts.",
        level: boostCount >= 7 ? "pass" : boostCount > 0 ? "neutral" : "neutral",
        points: Math.min(boostCount * SCORE_WEIGHTS.boostPoints, SCORE_WEIGHTS.boostCap) + (premiumTier === 3 ? SCORE_WEIGHTS.tier3Bonus : 0),
    });

    const score = Math.max(0, Math.min(100, Math.round(checks.reduce((acc, c) => acc + c.points, 0))));
    const analysis: GuildAnalysis = {
        guildId,
        name: inviteGuild.name ?? "Unknown",
        createdAt: createdAt.getTime(),
        createdAtLabel: createdAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        ageDays,
        joined: false,
        description: inviteGuild.description ?? null,
        verificationLevel,
        nsfwLevel,
        explicitContentFilter: inviteGuild.explicitContentFilter ?? 0,
        boostCount,
        premiumTier,
        trustFeatures,
        commerceFeatures: commerceFeatures,
        emojiCount: 0,
        stickerCount: 0,
        approximateMemberCount: inviteGuild.approximate_member_count ?? inviteGuild.approximateMemberCount,
        checks,
        score,
        bandIndex: SCORE_BANDS.indexOf(getBand(score)),
        partial: true,
    };
    cache.set(guildId, { analysis, fetchedAt: Date.now() });
    return analysis;
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { UserStore, UserProfileStore } from "@webpack/common";

import { CACHE_TTL_MS, DISCORD_EPOCH, EXPIRED_BADGE_IDS, SCORE_BANDS, SCORE_WEIGHTS } from "./constants";

/**
 * Discord's internal profile fetcher. Resolved lazily so this module can be
 * imported at plugin load (WebpackReady) time.
 */
const profileFetcher = findByPropsLazy("fetchProfile") as {
    fetchProfile: (userId: string, guildId?: string) => Promise<unknown>;
};

export interface BadgeDetail {
    id: string;
    description: string;
    /** True when the badge is no longer obtainable — a strong authenticity signal */
    expired: boolean;
}

export interface AccountAnalysis {
    userId: string;
    username: string;
    displayName: string;
    isBot: boolean;
    /** Account creation date derived from the snowflake */
    createdAt: number;
    createdAtLabel: string;
    ageDays: number;
    badgeDetails: BadgeDetail[];
    hasNitro: boolean;
    hasBanner: boolean;
    hasBio: boolean;
    hasAvatarDecoration: boolean;
    hasPronouns: boolean;
    hasClan: boolean;
    connectedAccountCount: number;
    score: number;
    bandIndex: number;
    /** True when parts of the analysis come from an incomplete (popout-less) profile */
    partial: boolean;
}

export interface bandInfo {
    label: string;
    emoji: string;
    color: string;
    note: string;
}

export function getBand(score: number): (typeof SCORE_BANDS)[number] {
    return SCORE_BANDS.reduce((acc, band) => (score >= band.min ? band : acc), SCORE_BANDS[0]);
}

export function accountAgeFromSnowflake(id: string) {
    return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

const listeners = new Set<() => void>();
const cache = new Map<string, { analysis: AccountAnalysis; fetchedAt: number; }>();
const pending = new Set<string>();
const inflight = new Map<string, Promise<AccountAnalysis | null>>();

function notify() {
    for (const l of listeners) l();
}

export function subscribeAnalysis(cb: () => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function getCachedAnalysis(userId: string | undefined) {
    return userId ? cache.get(userId)?.analysis : undefined;
}

export function isAnalyzing(userId: string | undefined) {
    return !!userId && pending.has(userId);
}

export function invalidateAnalysis() {
    cache.clear();
    notify();
}

function fromFlags(flags: bigint | number | undefined): string[] {
    const out: string[] = [];
    if (flags == null) return out;
    const f = BigInt(flags as unknown as bigint);
    const map: Record<string, bigint> = {
        Staff: 1n << 0n,
        Partner: 1n << 1n,
        HypeSquadOnlineHouses: 1n << 2n,
        HypeSquadEvents: 1n << 3n,
        BugHunterLevel1: 1n << 4n,
        BugHunterLevel2: 1n << 14n,
        VerifiedBot: 1n << 16n,
        VerifiedDeveloper: 1n << 17n,
        EarlySupporter: 1n << 18n,
        EarlyVerifiedBotDeveloper: 1n << 19n,
        ActiveDeveloper: 1n << 22n,
    };
    for (const [id, bit] of Object.entries(map)) {
        if ((f & bit) !== 0n) out.push(id);
    }
    return out;
}

function labelForBadge(id: string) {
    // fall back to the description we got from the profile if available; ids are normalized upstream
    return id;
}

export async function analyzeUser(userId: string): Promise<AccountAnalysis | null> {
    const fresh = cache.get(userId);
    if (fresh && Date.now() - fresh.fetchedAt < CACHE_TTL_MS) return fresh.analysis;

    const running = inflight.get(userId);
    if (running) return running;

    const job = (async () => {
        const user = UserStore.getUser(userId);
        if (!user) return null;

        let profile = UserProfileStore.getUserProfile(userId) as any;
        if (!profile) {
            try {
                profile = (await profileFetcher.fetchProfile(userId)) as any;
            } catch {
                // keep going with whatever local data we have
            }
        }

        const badgeIds = (profile?.badges as any[] | undefined)?.map(b => b?.id).filter(Boolean) ?? [];
        for (const id of fromFlags(user?.flags as number)) {
            if (!badgeIds.includes(id)) badgeIds.push(id);
        }

        const badgeDetails: BadgeDetail[] = badgeIds.map(id => ({
            id,
            description: labelForBadge(id),
            expired: EXPIRED_BADGE_IDS.has(id),
        }));

        const createdAt = accountAgeFromSnowflake(userId);
        const ageDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86_400_000));
        const hasNitro = (profile?.premiumType ?? (user as any)?.premiumType ?? 0) > 0;

        const checks = {
            hasNitro,
            hasBanner: !!profile?.banner || !!user?.banner,
            hasBio: !!profile?.bio,
            hasAvatarDecoration: !!user?.avatarDecorationData,
            hasPronouns: !!profile?.pronouns,
            hasClan: !!user?.primaryGuild?.identityGuildId,
        };

        const partial = !profile;

        const score = computeScore({ ageDays, badgeDetails, connectedAccountCount: profile?.connectedAccounts?.length ?? 0, ...checks });
        const analysis: AccountAnalysis = {
            userId,
            username: (user as any).username ?? userId,
            displayName: (user as any).displayName ?? (user as any).username ?? userId,
            isBot: !!user?.bot,
            createdAt: createdAt.getTime(),
            createdAtLabel: createdAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
            ageDays,
            badgeDetails,
            connectedAccountCount: profile?.connectedAccounts?.length ?? 0,
            ...checks,
            score,
            bandIndex: SCORE_BANDS.indexOf(getBand(score)),
            partial,
        };

        cache.set(userId, { analysis, fetchedAt: Date.now() });
        return analysis;
    })();

    pending.add(userId);
    inflight.set(userId, job);
    notify();

    try {
        const result = await job;
        return result;
    } finally {
        pending.delete(userId);
        inflight.delete(userId);
        notify();
    }
}

export function computeScore(m: {
    ageDays: number;
    badgeDetails: BadgeDetail[];
    hasNitro: boolean;
    hasBanner: boolean;
    hasBio: boolean;
    hasAvatarDecoration: boolean;
    hasPronouns: boolean;
    hasClan: boolean;
    connectedAccountCount: number;
}) {
    let score = 0;

    const years = Math.floor(m.ageDays / 365);
    score += Math.min(years * SCORE_WEIGHTS.ageDaysPerYear, 40);

    score += Math.min(m.badgeDetails.length * SCORE_WEIGHTS.badgePoints, 18);
    score += Math.min(m.badgeDetails.filter(b => b.expired).length * SCORE_WEIGHTS.expiredBadgeBonus, 12);

    let profileInvestment = 0;
    if (m.hasBanner) profileInvestment += 10;
    if (m.hasBio) profileInvestment += 5;
    if (m.hasAvatarDecoration) profileInvestment += 5;
    if (m.hasPronouns) profileInvestment += 2;
    if (m.hasClan) profileInvestment += 5;
    score += profileInvestment;

    if (m.hasNitro) score += SCORE_WEIGHTS.nitroPoints;
    score += Math.min(m.connectedAccountCount * 2, 10);

    return Math.max(0, Math.min(100, Math.round(score)));
}

/** Short human-readable summary used by the /accountcheck command */
export function summarize(a: AccountAnalysis): string {
    const band = getBand(a.score);
    const parts: string[] = [];

    parts.push(`🔍 **Account Checker — ${a.displayName}** (${a.userId})`);
    parts.push(band.emoji + " **" + band.label + "** — score **" + a.score + "/100** · " + band.note);

    parts.push([
        `- Account created: ${a.createdAtLabel} (**${a.ageDays}** days ago)`,
        `- Badges: ${a.badgeDetails.length ? a.badgeDetails.map(id => id.description).join(", ") : "none"}`,
        `- Nitro: ${a.hasNitro ? "yes" : "no"}`,
    ].join("\n"));

    return parts.join("\n");
}

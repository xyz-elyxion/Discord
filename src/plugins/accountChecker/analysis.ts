/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { RelationshipStore, UserProfileStore,UserStore } from "@webpack/common";

import { BADGE_LABELS,CACHE_TTL_MS, DISCORD_EPOCH, EXPIRED_BADGE_IDS, FLAG_WEIGHTS, SCORE_BANDS, SCORE_WEIGHTS } from "./constants";

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

/** What a single check looks like once it has run against an account */
export interface CheckResult {
    /** Stable id used by the settings toggle */
    id: string;
    /** Human-readable name of the check */
    label: string;
    /** One-line verdict — shown under the checklist */
    note: string;
    /** green pass, amber neutral/unknown, red warn */
    level: "pass" | "warn" | "neutral";
    /** How much this check adds to the score when passing (negative = warning) */
    points: number;
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
    /** Friendship / block / stranger state from RelationshipStore, null when unknown */
    relationship: "friend" | "blocked" | "pending-in" | "pending-out" | "stranger" | "none" | null;
    isSpamRelationship: boolean;
    /** Mutual server count with the current user, null when the guild module or data isn't available */
    mutualServers: number | null;
    /** Was this user marked spammer by Discord */
    flaggedSpam: boolean;
    /** Fluffy checks: full-URL threat intel and nick-vs-disc-name mismatch */
    checks: CheckResult[];
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

const FLAG_MAP: Record<string, bigint> = {
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

/** Fluffy, static checks (add or remove) — adjust score, shown in the UI checklist */
function fromFlags(flags: bigint | number | undefined): string[] {
    const out: string[] = [];
    if (flags == null) return out;
    const f = BigInt(flags as unknown as bigint);
    for (const [id, bit] of Object.entries(FLAG_MAP)) {
        if ((f & bit) !== 0n) out.push(id);
    }
    return out;
}

function labelForBadge(id: string) {
    return BADGE_LABELS[id] ?? id;
}

/** Best-effort relationship state from what's cached in the client */
function relationshipOf(userId: string): AccountAnalysis["relationship"] {
    try {
        const type = RelationshipStore.getRelationshipType(userId);
        if (type == null) return null;
        // RelationshipTypes enum: 1 friend, 2 blocked, 3 pending incoming, 4 pending outgoing, 0 none
        switch (type) {
            case 1: return "friend";
            case 2: return "blocked";
            case 3: return "pending-in";
            case 4: return "pending-out";
            case 0: return "none";
            default: return "stranger";
        }
    } catch {
        return null;
    }
}

/** Heuristic score adjustments that read like user info favours, bundled individually */
function flagPoints(ids: string[]): number {
    let sum = 0;
    for (const id of ids) sum += FLAG_WEIGHTS[id] ?? 10;
    return sum;
}

/** Detect the "identity-swap" pattern: display name differs materially from username root. */
function identitySwap(username: string, displayName: string): boolean {
    if (!username || !displayName) return false;
    const user = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const disp = displayName.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!user || !disp) return false;
    return !user.includes(disp) && !disp.includes(user);
}

/** Bot-looking-name heuristics, lowercase matching inside substrings of username/display name */
const SUSPICIOUS_TERMS = [
    "gift", "nitro", "free", "steam", "airdrop", "elite", "xv", "op", "vouches",
] as const;

function termHits(...names: (string | undefined)[]): string[] {
    const hits = new Set<string>();
    const combined = (names.filter(Boolean).join(" ") || "").toLowerCase();
    if (!combined) return [];
    for (const term of SUSPICIOUS_TERMS) {
        if (combined.includes(term)) hits.add(term);
    }
    return [...hits];
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
        const username = (user as any).username ?? userId;
        const displayName = (user as any).displayName ?? (user as any).username ?? userId;

        const relationship = relationshipOf(userId);
        const isSpamRelationship = ((): boolean => {
            try {
                return !!RelationshipStore.isSpam?.(userId);
            } catch {
                return false;
            }
        })();

        const blocked = relationship === "blocked";
        const olderThan90 = ageDays >= 90;
        const olderThanYear = ageDays >= 365;

        const checks: CheckResult[] = [];

        // -- Hard checks ----------------------------------------------------------
        checks.push({
            id: "age-90",
            label: "Older than 90 days",
            note: ageDays >= 90
                ? `Created ${createdAt.toLocaleDateString()} — ${ageDays} days old.`
                : "Newer than 90 days — the most common alt / freshly-created scambait signal.",
            level: olderThan90 ? "pass" : "warn",
            points: Math.min(Math.floor(ageDays / 30) * 2, 12),
        });
        if (olderThanYear) {
            checks.push({
                id: "age-1y",
                label: "Older than a year",
                note: `${Math.floor(ageDays / 365)} year(s) of registration history — strong genuine signal.`,
                level: "pass",
                points: 8,
            });
        } else {
            checks.push({
                id: "age-1y",
                label: "Older than a year",
                note: "Registered within the last year — new accounts are cheap.",
                level: "neutral",
                points: 0,
            });
        }

        // -- Badges ---------------------------------------------------------------
        const unobtainable = badgeDetails.filter(b => b.expired);
        checks.push({
            id: "expired-badges",
            label: "Unobtainable badges",
            note: unobtainable.length
                ? `${unobtainable.length} badge(s) that can't be earned anymore — account predates an event.`
                : "No unobtainable badges — not conclusive by itself (many genuine users have none).",
            level: unobtainable.length ? "pass" : "neutral",
            points: unobtainable.length * 5,
        });

        // -- Flags ----------------------------------------------------------------
        const flagIds = fromFlags(user?.flags as number);
        const flagScore = flagPoints(flagIds);
        checks.push({
            id: "flags",
            label: "Special flags",
            note: flagIds.length
                ? `${flagIds.join(", ")} — hard-to-get Discord-verified roles.`
                : "No special flags — expected for the vast majority of accounts.",
            level: flagIds.length ? "pass" : "neutral",
            points: flagScore,
        });

        // -- Identity matching ----------------------------------------------------
        const swap = identitySwap(username, displayName);
        checks.push({
            id: "identity-swap",
            label: "Username / display name match",
            note: swap
                ? `"${displayName}" shares no text with "${username}" — quick identity swap, common on burner accounts.`
                : "Display name and username look consistent.",
            level: swap ? "warn" : "pass",
            points: swap ? -10 : 0,
        });

        // -- Spam / blocks --------------------------------------------------------
        checks.push({
            id: "spam-or-block",
            label: "Spam / block status",
            note: isSpamRelationship
                ? "Discord flagged this user as spam on your end — strong signal."
                : blocked
                    ? "You have this user blocked."
                    : "No spam or block record found.",
            level: isSpamRelationship || blocked ? "warn" : "pass",
            points: (isSpamRelationship || blocked) ? -20 : 0,
        });

        // -- Bot -----------------------------------------------------------------
        checks.push({
            id: "is-bot",
            label: "Bot account",
            note: user?.bot ? "This is a bot account — most checks are irrelevant." : "Not a bot account.",
            level: user?.bot ? "neutral" : "pass",
            points: 0,
        });

        // -- Profile investment --------------------------------------------------
        const investment: string[] = [];
        if (profile?.banner || (user as any)?.banner) investment.push("banner");
        if (profile?.bio) investment.push("bio");
        if ((user as any).avatarDecorationData) investment.push("avatar decoration");
        if (profile?.pronouns) investment.push("pronouns");
        if ((user as any).primaryGuild?.identityGuildId) investment.push("clan tag");
        checks.push({
            id: "profile-investment",
            label: "Profile investment",
            note: investment.length
                ? `Custom ${investment.join(", ")} — some effort put into the profile.`
                : "Default everything — could be lazy rather than an alt, but next to an old account it looks more suspicious.",
            level: investment.length >= 2 ? "pass" : investment.length === 1 ? "neutral" : "warn",
            points: investment.length * 4,
        });

        // -- Connected accounts --------------------------------------------------
        const connectionCount = profile?.connectedAccounts?.length ?? 0;
        checks.push({
            id: "connections",
            label: "Linked accounts",
            note: connectionCount
                ? `${connectionCount} linked (Spotify, Steam, …) — effort to look real.`
                : "No linked accounts — many alts skip this; not conclusive by itself.",
            level: connectionCount > 0 ? "pass" : "neutral",
            points: Math.min(connectionCount * 3, 9),
        });

        // -- Nitro ----------------------------------------------------------------
        checks.push({
            id: "nitro",
            label: "Nitro",
            note: hasNitro
                ? "Nitro is active — real money spent on this account."
                : "No active Nitro.",
            level: hasNitro ? "pass" : "neutral",
            points: hasNitro ? SCORE_WEIGHTS.nitroPoints : 0,
        });

        // -- Suspicious terms ---------------------------------------------------
        const termList = termHits(username, displayName);
        checks.push({
            id: "suspicious-terms",
            label: "Suspicious terms in name",
            note: termList.length
                ? `Name contains "${termList.join("\", \"")}" — common bait keywords in scam accounts (gift/nitro/free…).`
                : "No bait-type terms (gift / nitro / free / steam…) in the name.",
            level: termList.length ? "warn" : "pass",
            points: termList.length ? -8 : 0,
        });

        // Total up score with all bonuses/penalties applied, clamped to 0-100
        const totalFromChecks = checks.reduce((acc, c) => acc + c.points, 0);
        const score = Math.max(0, Math.min(100, Math.round(totalFromChecks)));

        const analysis: AccountAnalysis = {
            userId,
            username,
            displayName,
            isBot: !!user?.bot,
            createdAt: createdAt.getTime(),
            createdAtLabel: createdAt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
            ageDays,
            badgeDetails,
            connectedAccountCount: connectionCount,
            relationship,
            isSpamRelationship,
            mutualServers: null,
            flaggedSpam: isSpamRelationship,
            checks,
            hasNitro,
            hasBanner: checks.find(c => c.id === "profile-investment")?.note.includes("banner") ?? false,
            hasBio: checks.find(c => c.id === "profile-investment")?.note.includes("bio") ?? false,
            hasAvatarDecoration: checks.find(c => c.id === "profile-investment")?.note.includes("avatar decoration") ?? false,
            hasPronouns: checks.find(c => c.id === "profile-investment")?.note.includes("pronouns") ?? false,
            hasClan: checks.find(c => c.id === "profile-investment")?.note.includes("clan tag") ?? false,
            score,
            bandIndex: SCORE_BANDS.indexOf(getBand(score)),
            partial: !profile,
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
    score += Math.min(m.connectedAccountCount * SCORE_WEIGHTS.connectionPoints, 10);

    return Math.max(0, Math.min(100, Math.round(score)));
}

/** Short human-readable summary used by the /accountcheck command */
export function summarize(a: AccountAnalysis): string {
    const band = getBand(a.score);
    const parts: string[] = [];

    parts.push(`🔍 **Account Checker — ${a.displayName}** (${a.userId})`);
    parts.push(band.emoji + " **" + band.label + "** — score **" + a.score + "/100** · " + band.note);

    const warns = a.checks.filter(c => c.level === "warn");
    if (warns.length) {
        parts.push(`⚠️ **${warns.length} warning${warns.length === 1 ? "" : "s"}**: ` + warns.map(c => c.label).join(", "));
    }

    parts.push([
        `- Account created: ${a.createdAtLabel} (**${a.ageDays}** days ago)`,
        `- Badges: ${a.badgeDetails.length ? a.badgeDetails.map(b => b.description).join(", ") : "none"}`,
        `- Nitro: ${a.hasNitro ? "yes" : "no"}`,
    ].join("\n"));

    return parts.join("\n");
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface OrbReward {
    /** orbQuantity, summed over every reward entry that carries one. */
    orbs: number;
    /**
     * premiumOrbQuantity, the payout for an account Discord boosts (Nitro or Xbox Game Pass).
     * Equals orbs when Discord sends no separate figure.
     */
    premiumOrbs: number;
}

function finite(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Orbs a quest pays out, or null when it pays none.
 *
 * Every reward entry is summed. Reward type 4 is what the picker colours a quest by, but the
 * quantity lives on the entry and a quest may list several, so reading rewards[0] under-reports
 * a quest that lists an in-game item before its Orbs.
 *
 * premiumOrbQuantity is Discord's own Nitro figure (1.2x per its Orbs FAQ) and is sometimes
 * absent or equal to orbQuantity, so it falls back to the base number rather than being
 * multiplied here.
 */
export function questOrbReward(config: any): OrbReward | null {
    const rewards = config?.rewardsConfig?.rewards;
    if (!Array.isArray(rewards)) return null;

    let orbs = 0;
    let premiumOrbs = 0;
    for (const reward of rewards) {
        const base = finite(reward?.orbQuantity);
        if (!base) continue;
        orbs += base;
        premiumOrbs += finite(reward?.premiumOrbQuantity) || base;
    }

    return orbs > 0 ? { orbs, premiumOrbs } : null;
}

/** Sum of several quests' payouts, or null when none of them pay Orbs. */
export function totalOrbReward(rewards: Array<OrbReward | null>): OrbReward | null {
    let orbs = 0;
    let premiumOrbs = 0;
    for (const reward of rewards) {
        if (!reward) continue;
        orbs += reward.orbs;
        premiumOrbs += reward.premiumOrbs;
    }

    return orbs > 0 ? { orbs, premiumOrbs } : null;
}

/**
 * One payout as text, empty for a quest that pays no Orbs.
 *
 * Only the figure the account will receive is printed: the premium one when Discord boosts
 * the account, the base one otherwise. A total passed through here lands on the same side as
 * the per-quest lines it sums, so the two agree.
 */
export function formatOrbReward(reward: OrbReward | null, boosted: boolean): string {
    if (!reward) return "";
    return `${boosted ? reward.premiumOrbs : reward.orbs} Orbs`;
}

/**
 * The Orb balance Discord reports for the account, or null for anything that is not a whole
 * non-negative number. Zero is a real balance and is kept, unlike a payout of zero.
 */
export function orbBalance(value: unknown): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The balance as text, empty when it is unknown. */
export function formatOrbBalance(balance: number | null): string {
    return balance === null ? "" : `${balance} Orbs`;
}

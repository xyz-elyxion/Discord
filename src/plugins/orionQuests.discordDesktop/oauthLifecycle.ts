/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface OAuthGrantLike {
    id: string;
    application?: { id?: string; };
}

export type OAuthCleanupOutcome =
    | { status: "cleaned"; deleted: number; }
    | { status: "account-changed"; deleted: number; }
    | { status: "account-unavailable"; deleted: number; };

type OAuthAccountState = "same" | "changed" | "unknown";

function accountState(currentAccountId: string | null, accountId: string): OAuthAccountState {
    if (currentAccountId == null) return "unknown";
    return currentAccountId === accountId ? "same" : "changed";
}

/**
 * Revoke only grants created after this task's snapshot, and never continue cleanup after the
 * active Discord account changes. A missing identity is not proof of an account switch, but it is
 * also not enough authority to touch OAuth state, so cleanup fails closed instead of waiting.
 * Already-issued requests cannot be unsent, so ownership is checked before the list request,
 * after it settles, and immediately before every DELETE boundary.
 */
export async function cleanupCreatedOAuthGrants(options: {
    accountId: string;
    appId: string;
    preGrantIds: Set<string>;
    getCurrentAccountId: () => string | null;
    listGrants: () => Promise<OAuthGrantLike[]>;
    deleteGrant: (id: string) => Promise<void>;
}): Promise<OAuthCleanupOutcome> {
    const {
        accountId,
        appId,
        preGrantIds,
        getCurrentAccountId,
        listGrants,
        deleteGrant,
    } = options;

    let deleted = 0;
    const stopForOwnership = (): OAuthCleanupOutcome | null => {
        const state = accountState(getCurrentAccountId(), accountId);
        if (state === "same") return null;
        return {
            status: state === "changed" ? "account-changed" : "account-unavailable",
            deleted,
        };
    };

    let ownership = stopForOwnership();
    if (ownership) return ownership;

    // No await sits between the ownership check above and invoking the request.
    const listing = listGrants();
    const after = await listing;

    ownership = stopForOwnership();
    if (ownership) return ownership;

    const created = after.filter(grant =>
        grant.application?.id === appId && !preGrantIds.has(grant.id)
    );

    for (const grant of created) {
        ownership = stopForOwnership();
        if (ownership) return ownership;

        // Keep DELETE invocation in the same synchronous turn as the final ownership read.
        const deletion = deleteGrant(grant.id);
        await deletion;
        deleted++;
    }

    return { status: "cleaned", deleted };
}

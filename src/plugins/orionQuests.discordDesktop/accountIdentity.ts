/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * A missing identity is an observation gap, not evidence that Discord switched accounts.
 * Only a different confirmed non-null id proves that account-owned runtime state is stale.
 */
export function isConfirmedDifferentAccount(currentUserId: string | null, expectedUserId: string): boolean {
    return currentUserId != null && currentUserId !== expectedUserId;
}

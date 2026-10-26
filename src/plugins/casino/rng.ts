/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Uniformly random integer in `[0, max)`, using the platform CSPRNG when available. */
export function randomInt(max: number): number {
    max = Math.floor(max);
    if (max <= 0) return 0;

    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        // Rejection sampling keeps the distribution uniform for non power-of-two ranges
        const limit = Math.floor(0x100000000 / max) * max;
        const buffer = new Uint32Array(1);
        let value: number;
        do {
            crypto.getRandomValues(buffer);
            value = buffer[0];
        } while (value >= limit);

        return value % max;
    }

    return Math.floor(Math.random() * max);
}

/** Uniformly random float in `[0, 1)`. */
export function randomFloat(): number {
    return randomInt(0x100000) / 0x100000;
}

export function shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

export function pickWeighted<T extends { weight: number; }>(items: readonly T[]): T {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = randomInt(total);

    for (const item of items) {
        roll -= item.weight;
        if (roll < 0) return item;
    }

    return items[items.length - 1];
}

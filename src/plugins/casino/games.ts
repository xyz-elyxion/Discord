/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { pickWeighted, randomFloat, randomInt, shuffle } from "./rng";

/* Coinflip */

export type CoinSide = "heads" | "tails";

export function flipCoin(): CoinSide {
    return randomInt(2) === 0 ? "heads" : "tails";
}

/* Roulette */

export const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function spinRoulette() {
    return randomInt(37);
}

export function rouletteColor(number: number): "red" | "black" | "green" {
    if (number === 0) return "green";
    return RED_NUMBERS.has(number) ? "red" : "black";
}

export interface RouletteBet {
    label: string;
    multiplier: number;
    covers(number: number): boolean;
}

/** Turns the `type` + `value` command options into a concrete bet, or explains what's wrong. */
export function parseRouletteBet(typeRaw: string | undefined, valueRaw: string | undefined): RouletteBet | { error: string; } {
    const type = (typeRaw ?? "color").toLowerCase();

    // Players usually pass "17" or "red" and skip the type option, so guess it from the value
    const value = (valueRaw ?? "").trim().toLowerCase();
    const effectiveType = valueRaw && !typeRaw ? guessRouletteType(value) : type;

    switch (effectiveType) {
        case "color": {
            if (value !== "red" && value !== "black")
                return { error: "For a colour bet the value has to be `red` or `black`." };

            return { label: value, multiplier: 2, covers: number => rouletteColor(number) === value };
        }

        case "number": {
            const number = Number(value);
            if (!Number.isInteger(number) || number < 0 || number > 36)
                return { error: "For a straight number bet the value has to be a whole number from 0 to 36." };

            return { label: `number ${number}`, multiplier: 36, covers: roll => roll === number };
        }

        case "range": {
            if (value === "1-18" || value === "low")
                return { label: "1-18", multiplier: 2, covers: number => number >= 1 && number <= 18 };
            if (value === "19-36" || value === "high")
                return { label: "19-36", multiplier: 2, covers: number => number >= 19 && number <= 36 };

            return { error: "For a range bet the value has to be `1-18` or `19-36`." };
        }

        case "dozen": {
            if (value === "1-12")
                return { label: "1-12", multiplier: 3, covers: number => number >= 1 && number <= 12 };
            if (value === "13-24")
                return { label: "13-24", multiplier: 3, covers: number => number >= 13 && number <= 24 };
            if (value === "25-36")
                return { label: "25-36", multiplier: 3, covers: number => number >= 25 && number <= 36 };

            return { error: "For a dozen bet the value has to be `1-12`, `13-24` or `25-36`." };
        }

        default:
            return { error: "Pick a bet type: `color`, `number`, `range` or `dozen`." };
    }
}

function guessRouletteType(value: string) {
    if (value === "red" || value === "black") return "color";
    if (value === "1-18" || value === "19-36") return "range";
    if (value === "1-12" || value === "13-24" || value === "25-36") return "dozen";
    return "number";
}

/* Slots */

export interface SlotSymbol {
    symbol: string;
    weight: number;
    /** Payout multiplier for three of a kind. */
    triple: number;
    /** Payout multiplier for exactly two of a kind. */
    pair: number;
}

export const SLOT_SYMBOLS: SlotSymbol[] = [
    { symbol: "🍒", weight: 26, triple: 3, pair: 1.4 },
    { symbol: "🍋", weight: 22, triple: 4, pair: 1.5 },
    { symbol: "🍇", weight: 18, triple: 5, pair: 1.6 },
    { symbol: "🔔", weight: 14, triple: 8, pair: 1.8 },
    { symbol: "⭐", weight: 10, triple: 12, pair: 2 },
    { symbol: "7️⃣", weight: 7, triple: 20, pair: 2.5 },
    { symbol: "💎", weight: 3, triple: 50, pair: 3 }
];

export function spinSlots(): SlotSymbol[] {
    return [pickWeighted(SLOT_SYMBOLS), pickWeighted(SLOT_SYMBOLS), pickWeighted(SLOT_SYMBOLS)];
}

export function slotsResult(reels: SlotSymbol[]): { multiplier: number; description: string; } {
    const [first, second, third] = reels;

    if (first.symbol === second.symbol && second.symbol === third.symbol)
        return { multiplier: first.triple, description: `${first.symbol}${first.symbol}${first.symbol}` };

    if (first.symbol === second.symbol) return { multiplier: first.pair, description: `two ${first.symbol}` };
    if (second.symbol === third.symbol) return { multiplier: second.pair, description: `two ${second.symbol}` };
    if (first.symbol === third.symbol) return { multiplier: first.pair, description: `two ${first.symbol}` };

    return { multiplier: 0, description: "no match" };
}

/* Plinko */

export const PLINKO_ROWS = [8, 12, 16];

const PLINKO_MULTIPLIERS: Record<number, number[]> = {
    8: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    12: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16]
};

export function plinkoMultipliers(rows: number) {
    return PLINKO_MULTIPLIERS[rows] ?? PLINKO_MULTIPLIERS[8];
}

export function dropPlinko(rows: number) {
    const path = Array.from({ length: rows }, (): "L" | "R" => (randomInt(2) === 0 ? "L" : "R"));
    const slot = path.filter(side => side === "R").length;
    const multiplier = plinkoMultipliers(rows)[slot];

    return { path, slot, multiplier };
}

/* Dice */

export type DiceMode = "exact" | "over" | "under";

export function rollDice(sides: number) {
    return randomInt(sides) + 1;
}

export function diceMultiplier(mode: DiceMode, value: number, sides: number): number | null {
    if (mode === "exact") return sides;
    if (mode === "over") return value >= 1 && value < sides ? Math.round(sides / (sides - value) * 100) / 100 : null;
    if (mode === "under") return value > 1 && value <= sides ? Math.round(sides / (value - 1) * 100) / 100 : null;

    return null;
}

export function diceWins(mode: DiceMode, value: number, roll: number) {
    if (mode === "exact") return roll === value;
    if (mode === "over") return roll > value;
    if (mode === "under") return roll < value;

    return false;
}

/* Mines */

export const MINES_TILES = 25;

export function placeMines(count: number): Set<number> {
    const tiles = shuffle(Array.from({ length: MINES_TILES }, (_, index) => index));
    return new Set(tiles.slice(0, count));
}

/** Fair odds for `revealed` safe picks, minus a 1% house edge. */
export function minesMultiplier(mines: number, revealed: number) {
    if (revealed <= 0) return 1;

    let multiplier = 1;
    for (let i = 0; i < revealed; i++)
        multiplier *= (MINES_TILES - i) / (MINES_TILES - mines - i);

    return Math.round(multiplier * 0.99 * 100) / 100;
}

/* Crash */

const CRASH_GROWTH_PER_SECOND = 1.075;

export function crashMultiplierAt(elapsedMs: number) {
    return Math.round(CRASH_GROWTH_PER_SECOND ** (elapsedMs / 1000) * 100) / 100;
}

/** Bust point sampled so that betting is roughly a 3% house edge, capped at 60x. */
export function crashBustPoint() {
    const roll = Math.max(randomFloat(), 0.0001);
    return Math.min(60, Math.max(1.06, Math.round(0.97 / roll * 100) / 100));
}

/* Lucky seats, a non-violent elimination luck game */

export const LUCK_SEATS = 6;

/** Payout after clearing `n` seats; the last value is the full-clear jackpot. */
export const LUCK_MULTIPLIERS = [1.2, 1.5, 2, 3, 5.5];

export function luckMultiplier(cleared: number) {
    if (cleared <= 0) return 1;
    return LUCK_MULTIPLIERS[Math.min(cleared, LUCK_MULTIPLIERS.length) - 1];
}

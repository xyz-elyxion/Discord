/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

const BALANCE_KEY = "casino:balance";

export const STARTING_BALANCE = 1_000;
export const MIN_BET = 10;
export const MAX_BET = 1_000_000;

export function formatCoins(amount: number) {
    return `${Math.round(amount).toLocaleString("en-US")} 🪙`;
}

export function formatMultiplier(multiplier: number) {
    return `${multiplier.toFixed(2)}x`;
}

export async function getBalance(): Promise<number> {
    const stored = await DataStore.get<number>(BALANCE_KEY);

    if (typeof stored !== "number" || !Number.isFinite(stored)) return STARTING_BALANCE;

    return Math.max(0, Math.round(stored));
}

export async function setBalance(balance: number): Promise<number> {
    const value = Math.max(0, Math.round(balance));
    await DataStore.set(BALANCE_KEY, value);
    return value;
}

export async function addCoins(delta: number): Promise<number> {
    return setBalance((await getBalance()) + delta);
}

export type BetResult = { bet: number; } | { error: string; };

/** Validates a bet against the current balance without taking it. */
export async function checkBet(rawBet: unknown): Promise<BetResult> {
    if (rawBet == null) return { error: "Add a **bet** to start a round — for example `bet: 100`." };

    const bet = Math.floor(Number(rawBet));

    if (!Number.isFinite(bet) || bet <= 0) return { error: "Your bet has to be a positive number of coins." };
    if (bet < MIN_BET) return { error: `The minimum bet is ${formatCoins(MIN_BET)}.` };
    if (bet > MAX_BET) return { error: `The maximum bet is ${formatCoins(MAX_BET)}.` };

    const balance = await getBalance();
    if (bet > balance) return { error: `You only have ${formatCoins(balance)}. Lower your bet, or run \`/casino reset\` to start over.` };

    return { bet };
}

/** Validates a bet and takes it out of the wallet. */
export async function placeBet(rawBet: unknown): Promise<BetResult> {
    const result = await checkBet(rawBet);
    if ("error" in result) return result;

    await addCoins(-result.bet);
    return result;
}

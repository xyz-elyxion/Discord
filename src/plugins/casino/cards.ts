/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { shuffle } from "./rng";

export type Suit = "♠" | "♥" | "♦" | "♣";

export interface Card {
    rank: string;
    suit: Suit;
}

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function createDeck(): Card[] {
    return shuffle(SUITS.flatMap(suit => RANKS.map(rank => ({ rank, suit }))));
}

/** Rank order used for higher/lower: 2 lowest, ace highest. */
export function rankValue(card: Card): number {
    if (card.rank === "A") return 14;
    if (card.rank === "K") return 13;
    if (card.rank === "Q") return 12;
    if (card.rank === "J") return 11;

    return Number(card.rank);
}

/** Blackjack hand value, counting aces as 11 until the hand would bust. */
export function blackjackTotal(cards: Card[]): number {
    let total = 0;
    let aces = 0;

    for (const card of cards) {
        if (card.rank === "A") {
            total += 11;
            aces++;
        } else {
            total += Math.min(rankValue(card), 10);
        }
    }

    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }

    return total;
}

export function formatCard(card: Card) {
    return `${card.rank}${card.suit}`;
}

export function formatHand(cards: Card[]) {
    return `${cards.map(formatCard).join(" ")} (**${blackjackTotal(cards)}**)`;
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { Achievement, ACHIEVEMENTS, AchievementStats, isAchieved } from "./achievements";

const STORAGE_KEY = "LimeyAchievements_v1";
const SAVE_DEBOUNCE_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AchievementState {
    stats: AchievementStats;
    /** Achievement id -> ISO date it was first reached */
    unlocked: Record<string, string>;
    /** Local YYYY-MM-DD of the last day the plugin ran */
    lastActiveDay: string | null;
}

function emptyStats(): AchievementStats {
    return {
        messagesSent: 0,
        charactersTyped: 0,
        voiceMinutes: 0,
        guildsJoined: 0,
        daysActive: 0,
        dayStreak: 0,
        nightMessages: 0,
        earlyMessages: 0,
    };
}

let state: AchievementState = {
    stats: emptyStats(),
    unlocked: {},
    lastActiveDay: null,
};

let loaded = false;
let loadPromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
const unlockListeners = new Set<(achievement: Achievement) => void>();

export function getAchievementState(): AchievementState {
    // Return a fresh object so React subscribers re-render on every change;
    // `state` itself is mutated in place to keep the trackers cheap.
    return { ...state, stats: { ...state.stats } };
}

export function isAchievementsLoaded(): boolean {
    return loaded;
}

export function subscribeToAchievements(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function onAchievementUnlocked(listener: (achievement: Achievement) => void): () => void {
    unlockListeners.add(listener);
    return () => {
        unlockListeners.delete(listener);
    };
}

export function unlockedCount(stateOverride: AchievementState = state): number {
    return Object.keys(stateOverride.unlocked).length;
}

function emit() {
    for (const listener of listeners) listener();
}

function dayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushAchievements();
    }, SAVE_DEBOUNCE_MS);
}

export async function flushAchievements(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!loaded) return;
    await DataStore.set(STORAGE_KEY, state);
}

export function loadAchievements(): Promise<void> {
    loadPromise ??= (async () => {
        try {
            const saved = await DataStore.get<Partial<AchievementState>>(STORAGE_KEY);
            if (saved) {
                state = {
                    stats: { ...emptyStats(), ...saved.stats },
                    unlocked: saved.unlocked ?? {},
                    lastActiveDay: saved.lastActiveDay ?? null,
                };
            }
        } catch {
            // A corrupt or unavailable store must not break the plugin; start fresh.
            state = { stats: emptyStats(), unlocked: {}, lastActiveDay: null };
        }

        loaded = true;
        checkUnlocks();
        emit();
    })();

    return loadPromise;
}

function checkUnlocks() {
    const now = new Date().toISOString();
    const newlyUnlocked: Achievement[] = [];

    for (const achievement of ACHIEVEMENTS) {
        if (state.unlocked[achievement.id]) continue;
        if (!isAchieved(achievement, state.stats)) continue;

        state.unlocked[achievement.id] = now;
        newlyUnlocked.push(achievement);
    }

    for (const achievement of newlyUnlocked) {
        for (const listener of unlockListeners) listener(achievement);
    }

    return newlyUnlocked.length > 0;
}

function commit() {
    if (!loaded) return;
    const changed = checkUnlocks();
    emit();
    if (changed) void flushAchievements();
    else scheduleSave();
}

export function trackMessage(content: string, sentAt = new Date()) {
    if (!loaded) return;

    const hour = sentAt.getHours();
    state.stats.messagesSent++;
    state.stats.charactersTyped += content.length;
    if (hour >= 1 && hour < 5) state.stats.nightMessages++;
    else if (hour >= 5 && hour < 8) state.stats.earlyMessages++;

    commit();
}

export function addVoiceMinutes(minutes: number) {
    if (!loaded || minutes <= 0) return;
    state.stats.voiceMinutes += minutes;
    commit();
}

/** Guild count only ever grows, so leaving a server does not revoke the achievement. */
export function recordGuildCount(count: number) {
    if (!loaded || !Number.isFinite(count) || count <= state.stats.guildsJoined) return;
    state.stats.guildsJoined = count;
    commit();
}

/** Returns true when this is the first time the plugin has run today. */
export function markActiveDay(now = new Date()): boolean {
    if (!loaded) return false;

    const today = dayKey(now);
    if (state.lastActiveDay === today) return false;

    if (state.lastActiveDay) {
        const yesterday = dayKey(new Date(now.getTime() - DAY_MS));
        state.stats.dayStreak = state.lastActiveDay === yesterday ? state.stats.dayStreak + 1 : 1;
    } else {
        state.stats.dayStreak = Math.max(1, state.stats.dayStreak);
    }

    state.stats.daysActive++;
    state.lastActiveDay = today;
    commit();
    return true;
}

export async function resetAchievements(): Promise<void> {
    state = { stats: emptyStats(), unlocked: {}, lastActiveDay: null };
    loaded = true;
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await DataStore.del(STORAGE_KEY);
    emit();
}

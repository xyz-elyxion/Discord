/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

type Handler<T> = (value: T) => void;

let onAchievementBypass: Handler<boolean> | null = null;

export function setAchievementBypassHook(fn: Handler<boolean> | null): void {
    onAchievementBypass = fn;
}

/** No-op while the engine is down. Settings are read fresh at the next start. */
export function fireAchievementBypassChanged(value: boolean): void {
    onAchievementBypass?.(value);
}

let onOrbQuestsOnly: Handler<boolean> | null = null;

export function setOrbQuestsOnlyHook(fn: Handler<boolean> | null): void {
    onOrbQuestsOnly = fn;
}

/** No-op while the engine is down. The next start reads the setting fresh. */
export function fireOrbQuestsOnlyChanged(value: boolean): void {
    onOrbQuestsOnly?.(value);
}

let onWatchForEnrollments: Handler<boolean> | null = null;

/**
 * Registered by index.tsx rather than the engine: the watcher outlives a run by design, so
 * turning the setting off has to reach it even when nothing is running.
 */
export function setWatchForEnrollmentsHook(fn: Handler<boolean> | null): void {
    onWatchForEnrollments = fn;
}

export function fireWatchForEnrollmentsChanged(value: boolean): void {
    onWatchForEnrollments?.(value);
}

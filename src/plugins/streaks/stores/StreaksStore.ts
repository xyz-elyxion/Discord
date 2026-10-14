/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { proxyLazy } from "@utils/lazy";
import { moment, zustandCreate } from "@webpack/common";

const STORAGE_KEY = "vc-streaks-data-v2";
const LEGACY_STORAGE_KEY = "vc-streaks-data";

export interface LocalStreak {
    /** Streak length in days (each day both of you sent each other DMs) */
    count: number;
    /** The last date a day was counted, in YYYY-MM-DD format */
    last_streak_date: string | null;
    /** Whether you sent each other a DM today */
    my_today: boolean;
    /** Whether they sent you a DM today */
    their_today: boolean;
    /** The date the today-flags belong to */
    today_date: string | null;
}

export interface StreaksState {
    streaks: Record<string, LocalStreak>;
    load: () => Promise<void>;
    mark: (recipientId: string, side: "me" | "them") => Promise<void>;
    clear: () => Promise<void>;
}

function tickStreak(entry: LocalStreak, today: string, yesterday: string, side: "me" | "them") {
    // Reset the per-day flags when a new day starts
    if (entry.today_date !== today) {
        entry.today_date = today;
        entry.my_today = false;
        entry.their_today = false;
    }

    if (side === "me") entry.my_today = true;
    else entry.their_today = true;

    // A day only counts once both you and the other person have sent
    // each other a DM today, and only while the previous day was shared
    // too (otherwise the streak restarts at 1).
    if (entry.my_today && entry.their_today && entry.last_streak_date !== today) {
        entry.count = entry.last_streak_date === yesterday ? entry.count + 1 : 1;
        entry.last_streak_date = today;
    }
}

export const useStreaksStore = proxyLazy(() => zustandCreate((set: any, get: any) => ({
    streaks: {} as Record<string, LocalStreak>,

    async load() {
        // Import counts saved by the legacy (pre-OAuth) local system, if any
        const legacy = await DataStore.get<Record<string, any>>(LEGACY_STORAGE_KEY);
        if (legacy && typeof legacy === "object") {
            const imported: Record<string, LocalStreak> = {};
            let recognizable = false;
            for (const [userId, value] of Object.entries(legacy)) {
                if (value && typeof value === "object" && typeof value.count === "number" && (value.count as number) >= 0) {
                    recognizable = true;
                    imported[userId] = {
                        count: value.count as number,
                        last_streak_date: typeof value.last_streak_date === "string"
                            ? value.last_streak_date
                            : typeof value.last_date === "string"
                                ? value.last_date
                                : null,
                        my_today: false,
                        their_today: false,
                        today_date: null
                    };
                }
            }
            if (recognizable) {
                set({ streaks: { ...get().streaks, ...imported } });
                await DataStore.set(STORAGE_KEY, get().streaks);
                await DataStore.del(LEGACY_STORAGE_KEY);
            }
        }

        const data = await DataStore.get<Record<string, LocalStreak>>(STORAGE_KEY);
        if (data && typeof data === "object") {
            set({ streaks: data });
        }
    },

    async mark(recipientId: string, side: "me" | "them") {
        const today = moment().format("YYYY-MM-DD");
        const yesterday = moment().subtract(1, "day").format("YYYY-MM-DD");

        const streaks = { ...get().streaks };
        const entry: LocalStreak = streaks[recipientId] ?? {
            count: 0,
            last_streak_date: null,
            my_today: false,
            their_today: false,
            today_date: null
        };

        tickStreak(entry, today, yesterday, side);

        streaks[recipientId] = entry;
        set({ streaks });
        await DataStore.set(STORAGE_KEY, streaks);
    },

    async clear() {
        set({ streaks: {} });
        await DataStore.del(STORAGE_KEY);
    }
} as StreaksState)));

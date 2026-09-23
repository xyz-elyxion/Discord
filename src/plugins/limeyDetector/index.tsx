/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { UserStore } from "@webpack/common";

const API_URL = "https://limey-discord.onrender.com/v1/detector";

export default definePlugin({
    name: "LimeyV1Detector",
    description: "Detects who is running Limey V1. While this plugin is enabled it reports your own Limey V1 usage to the Limey backend (only your user ID, nothing else) and keeps a live list of everyone else running it.",
    tags: ["Utility", "Fun"],
    authors: [Devs.Limey],

    /** Cached set of user ids known to run Limey V1 */
    knownUsers: new Set<string>() as Set<string>,
    intervalId: undefined as ReturnType<typeof setInterval> | undefined,

    hasLimey(userId: string) {
        return this.knownUsers.has(userId);
    },

    async ping() {
        try {
            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) return;
            const res = await fetch(`${API_URL}/ping`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: myId })
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.users)) {
                    this.knownUsers = new Set<string>(data.users as string[]);
                }
            }
        } catch (e) {
            console.error("[LimeyV1Detector] ping failed:", e);
        }
    },

    start() {
        this.ping();
        this.intervalId = setInterval(() => this.ping(), 5 * 60 * 1000);
    },

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
    }
});

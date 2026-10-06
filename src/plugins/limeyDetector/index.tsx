/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { StartAt } from "@utils/types";
import { addProfileBadge, BadgePosition, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { UserStore } from "@webpack/common";

const API_URL = "https://limey-discord.onrender.com/v1/detector";

/** Cached set of user ids known to run Limey V1 */
const knownUsers = new Set<string>();

const LimeyBadge: ProfileBadge = {
    key: "limeyV1Detector",
    id: "limey_v1",
    description: "Running Limey V1",
    iconSrc: "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><text x="0" y="13" font-size="13">🍋</text></svg>'
    ),
    position: BadgePosition.END,
    shouldShow({ userId }) {
        return knownUsers.has(userId);
    }
};

export default definePlugin({
    name: "LimeyV1Detector",
    permissions: [{
        id: "pingLimeyServer",
        title: "Contact the Limey V1 detector API",
        description: "Sends periodic requests to limey-discord.onrender.com to detect other Limey V1 users and check status.",
        risk: "Reveals your IP address (used for a coarse country-level location shown on the dashboard globe) and usage times to the Limey V1 server."
    }],
    description: "Detects who is running Limey V1. While this plugin is enabled it reports your own Limey V1 usage to the Limey backend (only your user ID, nothing else) and keeps a live list of everyone else running it.",
    tags: ["Utility", "Fun"],
    authors: [Devs.Limey],
    enabledByDefault: true,
    startAt: StartAt.WebpackReady,

    hasLimey(userId: string) {
        return knownUsers.has(userId);
    },

    intervalId: undefined as ReturnType<typeof setInterval> | undefined,
    startRetryCount: 0 as number,

    async ping() {
        try {
            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) {
                // User store not ready yet (e.g. first start before login):
                // retry shortly instead of waiting the full ping interval.
                if (this.startRetryCount < 12) {
                    this.startRetryCount++;
                    setTimeout(() => void this.ping(), 15 * 1000);
                }
                return;
            }
            const res = await fetch(`${API_URL}/ping`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: myId })
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.users)) {
                    knownUsers.clear();
                    for (const id of data.users as string[]) knownUsers.add(id);
                }
            }
        } catch (e) {
            console.error("[LimeyV1Detector] ping failed:", e);
        }
    },

    start() {
        this.startRetryCount = 0;
        addProfileBadge(LimeyBadge);
        this.ping();
        this.intervalId = setInterval(() => this.ping(), 60 * 1000);
    },

    stop() {
        this.startRetryCount = 0;
        removeProfileBadge(LimeyBadge);
        if (this.intervalId) clearInterval(this.intervalId);
    }
});

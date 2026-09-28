/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const API_URL = "https://limey-discord.onrender.com/v1/status";

let lastActive = false;
let lastMessage = "";

export default definePlugin({
    name: "LimeyV1Status",
    permissions: [
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Makes network requests to Discord, CDNs and web APIs as part of normal operation.",
            risk: "Requests are made with your session; destinations see your IP address."
        }
    ],
    description: "Shows a notification when Limey V1's backend or the limebot is experiencing issues (e.g. Discord rate limiting), and when they are resolved.",
    tags: ["Utility"],
    authors: [Devs.Limey],

    intervalId: undefined as ReturnType<typeof setInterval> | undefined,

    async check() {
        try {
            const res = await fetch(API_URL, { signal: AbortSignal.timeout(10_000) } as any);
            if (!res.ok) return;
            const status = await res.json();
            if (!status || typeof status.active !== "boolean") return;

            if (status.active && (!lastActive || status.message !== lastMessage)) {
                showToast(status.message, Toasts.Type.MESSAGE);
            }
            // Only show the "back to normal" toast if we actually announced an issue this session
            if (!status.active && lastActive) {
                showToast("Limey V1 issues resolved — everything is back to normal.", Toasts.Type.SUCCESS);
            }

            lastActive = status.active;
            lastMessage = status.message || "";
        } catch {
            // Backend unreachable — likely the same issue; stay quiet
        }
    },

    start() {
        this.check();
        this.intervalId = setInterval(() => this.check(), 3 * 60 * 1000);
    },

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
    }
});

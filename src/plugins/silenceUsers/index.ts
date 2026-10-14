/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher } from "@webpack/common";

const settings = definePluginSettings({
    mutedUserIds: {
        type: OptionType.STRING,
        description: "Comma-separated Discord user IDs to silence pings and server badges.",
        default: "",
        restartNeeded: false,
    },
});

function getMutedIds(): Set<string> {
    const { mutedUserIds } = settings.store;
    const ids = mutedUserIds.split(",").map(id => id.trim()).filter(Boolean);
    return new Set(ids);
}

function interceptor(event: any) {
    try {
        const mutedIds = getMutedIds();
        if (!mutedIds.size) return;

        if (event.type === "MESSAGE_CREATE" || event.type === "MESSAGE_UPDATE") {
            const msg = event.message;
            if (!msg) return;

            const authorId = String(msg.author?.id ?? "");
            if (!authorId || !mutedIds.has(authorId)) return;

            msg.mention_everyone = false;
            msg.mention_roles = [];
            msg.mentions = [];
        }

        if (event.type === "NOTIFICATION_CREATE") {
            const msg = event?.message ?? event?.notification?.message;
            if (!msg) return;

            const authorId = String(msg?.author?.id ?? "");
            if (!authorId || !mutedIds.has(authorId)) return;

            return false;
        }
    } catch { }
}

export default definePlugin({
    name: "SilenceUsers",
    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own events and stores to read the content, authors and attachments of messages you can already see.",
            risk: "A buggy or abused plugin could collect, copy or act on private conversations."
        }
    ],
    description: "Silences @mention pings and server badge counts from specific users. Regular messages and DMs are untouched.",
    authors: [Devs.dka],
    tags: ["Notifications"],
    settings,
    start() {
        FluxDispatcher.addInterceptor(interceptor);
    },
    stop() {
        const list = FluxDispatcher._interceptors ?? [];
        const idx = list.indexOf(interceptor);
        if (idx !== -1) list.splice(idx, 1);
    },
});

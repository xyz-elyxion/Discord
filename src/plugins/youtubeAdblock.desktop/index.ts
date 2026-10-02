/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

// The entire code of this plugin can be found in native.ts
export default definePlugin({
    name: "YoutubeAdblock",
    permissions: [
        {
            id: "nativeCodeExecution",
            title: "Execute code in the main process",
            description: "Uses native Electron APIs (executeJavaScript/IPC) inside embedded views or the main process.",
            risk: "Runs code outside the normal sandbox; a bug or malicious content could act with full client privileges."
        }
    ],
    description: "Block ads in YouTube embeds and the WatchTogether activity via AdGuard",
    tags: ["Media", "Utility"],
    authors: [Devs.ImLvna, Devs.Ven],
});

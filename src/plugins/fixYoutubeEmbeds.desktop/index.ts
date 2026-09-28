/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2023 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "FixYoutubeEmbeds",
    permissions: [
        {
            id: "nativeCodeExecution",
            title: "Execute code in the main process",
            description: "Uses native Electron APIs (executeJavaScript/IPC) inside embedded views or the main process.",
            risk: "Runs code outside the normal sandbox; a bug or malicious content could act with full client privileges."
        }
    ],
    description: "Bypasses youtube videos being blocked from display on Discord (for example by UMG)",
    tags: ["Media", "Utility"],
    authors: [Devs.coolelectronics]
});

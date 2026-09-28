/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2024 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "ImageLink",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Never hide image links in messages, even if it's the only content",
    tags: ["Media", "Appearance"],
    authors: [Devs.Kyuuhachi, Devs.Sqaaakoi],

    patches: [
        {
            // small util file
            find: "={linkCount:0,onlyLinks:!1};function ",
            replacement: {
                // SimpleEmbedTypes.has(embed.type) && isEmbedInline(embed)
                match: /\i\.has\(\i\.type\)&&\(0,\i\.\i\)\(\i\)/,
                replace: "false",
            }
        }
    ]
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "DisableDeepLinks",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Disables Discord's stupid deep linking feature which tries to force you to use their Desktop App",
    tags: ["Utility"],
    authors: [Devs.Ven],
    required: true,

    noop: () => { },

    patches: [{
        find: /\.openNativeAppModal\(.{0,50}?\.DEEP_LINK/,
        replacement: {
            match: /\i\.\i\.openNativeAppModal/,
            replace: "$self.noop",
        }
    }]
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    reactionCount: {
        description: "Number of reactions (0-42)",
        type: OptionType.NUMBER,
        default: 5
    },
});

export default definePlugin({
    name: "MoreQuickReactions",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Increases the number of reactions available in the Quick React hover menu",
    authors: [Devs.iamme],
    tags: ["Emotes", "Reactions", "Customisation", "Shortcuts"],
    settings,

    get reactionCount() {
        return settings.store.reactionCount;
    },

    patches: [
        {
            find: "#{intl::MESSAGE_UTILITIES_A11Y_LABEL}),children",
            replacement: {
                match: /(?<=length>=3\?.{0,40})\.slice\(0,3\)/,
                replace: ".slice(0,$self.reactionCount)"
            }
        }
    ],
});

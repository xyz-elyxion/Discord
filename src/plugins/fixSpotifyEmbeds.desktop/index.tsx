/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { makeRange, OptionType } from "@utils/types";

const settings = definePluginSettings({
    volume: {
        type: OptionType.SLIDER,
        description: "The volume % to set for spotify embeds. Anything above 10% is veeeery loud",
        markers: makeRange(0, 100, 10),
        stickToMarkers: false,
        default: 10
    }
});

// The entire code of this plugin can be found in ipcPlugins
export default definePlugin({
    name: "FixSpotifyEmbeds",
    permissions: [
        {
            id: "nativeCodeExecution",
            title: "Execute code in the main process",
            description: "Uses native Electron APIs (executeJavaScript/IPC) inside embedded views or the main process.",
            risk: "Runs code outside the normal sandbox; a bug or malicious content could act with full client privileges."
        }
    ],
    description: "Fixes spotify embeds being incredibly loud by letting you customise the volume",
    authors: [Devs.Ven],
    tags: ["Media", "Customisation"],
    settings,
});

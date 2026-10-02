/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./clientTheme.css";

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, StartAt } from "@utils/types";

import { ResetThemeColorComponent, ThemeSettingsComponent } from "./components/Settings";
import { disableClientTheme, startClientTheme } from "./utils/styleUtils";

export const settings = definePluginSettings({
    color: {
        type: OptionType.COMPONENT,
        default: "313338",
        component: ThemeSettingsComponent
    },
    resetColor: {
        type: OptionType.COMPONENT,
        component: ResetThemeColorComponent
    }
});

export default definePlugin({
    name: "ClientTheme",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    authors: [Devs.Limey],
    description: "Recreation of the old client theme experiment. Add a color to your Discord client theme",
    tags: ["Appearance", "Customisation"],
    settings,

    startAt: StartAt.DOMContentLoaded,
    start: () => startClientTheme(settings.store.color),
    stop: disableClientTheme
});

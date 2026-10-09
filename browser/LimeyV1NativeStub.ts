/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/// <reference path="../src/modules.d.ts" />
/// <reference path="../src/globals.d.ts" />

// Be very careful with imports in this file to avoid circular dependency issues.
// Only import pure modules that don't import other parts of LimeyV1.
import * as DataStore from "@api/DataStore";
import type { Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { metaReady, RENDERER_CSS_URL } from "@utils/web-metadata";

const NOOP = () => { };

// probably should make this less cursed at some point
window.LimeyV1Native = {
    themes: {
        uploadTheme: async () => {},
        deleteTheme: async () => {},
        getThemesList: async () => [],
        getThemeData: async () => undefined,
        getSystemValues: async () => ({}),

        openFolder: async () => Promise.reject("themes:openFolder is not supported on web"),
    },

    native: {
        getVersions: () => ({}),
        supportsWindowsMaterial: () => false,
        openExternal: async (url) => void open(url, "_blank"),
        getRendererCss: async () => {
            if (IS_USERSCRIPT)
                // need to wait for next tick for _vcUserScriptRendererCss to be set
                return Promise.resolve().then(() => window._vcUserScriptRendererCss);

            await metaReady;

            return fetch(RENDERER_CSS_URL)
                .then(res => res.text());
        },
        onRendererCssUpdate: NOOP,
    },

    updater: {
        getRepo: async () => ({ ok: true, value: "https://limey-discord.onrender.com" }),
        getUpdates: async () => ({ ok: true, value: [] }),
        update: async () => ({ ok: true, value: false }),
        rebuild: async () => ({ ok: true, value: true }),
    },

    settings: {
        get: () => {
            try {
                return JSON.parse(localStorage.getItem("LimeyV1Settings") || "{}");
            } catch (e) {
                console.error("Failed to parse settings from localStorage: ", e);
                return {};
            }
        },
        set: async (s: Settings) => localStorage.setItem("LimeyV1Settings", JSON.stringify(s)),
        openFolder: async () => Promise.reject("settings:openFolder is not supported on web"),
    },

    pluginHelpers: {} as any,
    csp: {} as any,
};

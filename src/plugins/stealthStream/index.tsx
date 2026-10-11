/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
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
 * along with this program; if not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { UserStore } from "@webpack/common";

const logger = new Logger("StealthStream");

let capturedTitle = "";
let isStreaming = false;

const settings = definePluginSettings({
    hideUpdateNotifs: {
        type: OptionType.BOOLEAN,
        description: "Suppress update toasts while streaming.",
        default: true,
    },
    hideSetupToasts: {
        type: OptionType.BOOLEAN,
        description: "Suppress plugin-startup toasts while streaming.",
        default: true,
    },
    hideDebugOverlays: {
        type: OptionType.BOOLEAN,
        description: "Hide stream debug overlays while streaming.",
        default: true,
    },
});

/** Same ownership check StreamerModeOnStream uses. */
function isOwnStream({ streamKey }: { streamKey: string }) {
    return streamKey.endsWith(String(UserStore.getCurrentUser()?.id ?? ""));
}

export default definePlugin({
    name: "StealthStream",
    description: "Hides mod-identifying UI (update toasts, plugin toasts, debug overlays) while you are screen sharing or recording inside Discord.",
    tags: ["Privacy", "Utility"],
    authors: [Devs.Kaitlyn],
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI nodes that show mod branding",
            description: "Hides DOM nodes whose text mentions Limey V1 / Vencord while a stream is active.",
            risk: "Aggressive text matching could hide unrelated UI while streaming."
        }
    ],
    settings,

    flux: {
        STREAM_CREATE(d: { streamKey: string }) {
            if (!isOwnStream(d)) return;
            isStreaming = true;
        },
        STREAM_DELETE(d: { streamKey: string }) {
            if (!isOwnStream(d)) return;
            isStreaming = false;
        }
    },

    start() {
        capturedTitle = document.title;

        const suppressObserver = new MutationObserver(mutations => {
            if (!isStreaming) return;
            for (const m of mutations) {
                const target = m.target as HTMLElement | null;
                const text = target?.textContent ?? "";
                if (!target || !text) continue;
                if (/limey|vencord|plugin started/i.test(text)) {
                    target.style.visibility = "hidden";
                }
            }
        });
        suppressObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

        (this as any)._observer = suppressObserver;

        logger.info("StealthStream started");
    },

    stop() {
        (this as any)._observer?.disconnect();
        (this as any)._observer = undefined;
        isStreaming = false;
        if (capturedTitle && document.title !== capturedTitle) {
            document.title = capturedTitle;
        }
    }
});

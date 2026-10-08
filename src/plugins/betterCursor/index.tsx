/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

import { CursorOverlay } from "./cursor";

const settings = definePluginSettings({
    trailStrength: {
        type: OptionType.SLIDER,
        description: "How much the cursor trails behind (higher = springier)",
        markers: [1, 2, 3, 4, 5],
        default: 2,
        stickToMarkers: true
    },
    size: {
        type: OptionType.SLIDER,
        description: "Cursor size (px)",
        markers: [24, 32, 40, 50, 64, 80],
        default: 50,
        stickToMarkers: true
    },
    hideSystemCursor: {
        type: OptionType.BOOLEAN,
        description: "Hide the system cursor while BetterCursor is active",
        default: true,
        onChange: (v: boolean) => {
            document.body.style.cursor = v ? "none" : "auto";
        }
    }
});

export default definePlugin({
    name: "BetterCursor",
    description: "Spring-animated cursor that trails and rotates with your movement. Custom cursor effects for your client.",
    tags: ["Fun", "Appearance"],
    authors: [Devs.Limey],
    settings,

    settingsAboutComponent: () => {
        const { trailStrength, size, hideSystemCursor } = settings.use(["trailStrength", "size", "hideSystemCursor"]);
        return (
            <div style={{ opacity: 0.8 }}>
                <b>Current settings:</b> size {size}px, trail {trailStrength}/5, system cursor {hideSystemCursor ? "hidden" : "visible"}.
                <br />
                Move your mouse around to see the effect. Use the sliders above to tune the feel.
            </div>
        );
    },

    start() {
        CursorOverlay.mount(settings.store);
    },

    stop() {
        CursorOverlay.unmount();
        document.body.style.cursor = "auto";
    }
});

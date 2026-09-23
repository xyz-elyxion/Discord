/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "BetterAnimations" by arg0NNY
 * (https://github.com/okdevme/DiscordPlugins) — re-implemented natively
 * for Limey V1 with a simplified settings surface.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

// Discord's built-in loading spinner animation types (webpack module with WANDERING_CUBES etc.)
export const SpinnerTypes = {
    WanderingCubes: "WANDERING_CUBES",
    ChasingDots: "CHASING_DOTS",
    Circle: "CIRCLE",
    BouncingBall: "BOUNCING_BALL",
    Pulses: "PULSES",
    Typing: "TYPING",
    SpinningCircle: "SPINNING_CIRCLE",
    SpinningCircleSimple: "SPINNING_CIRCLE_SIMPLE",
    LowMotion: "LOW_MOTION",
} as const;

const SpinnerOptions = [
    { label: "Wandering Cubes (default)", value: SpinnerTypes.WanderingCubes },
    { label: "Chasing Dots", value: SpinnerTypes.ChasingDots },
    { label: "Circle", value: SpinnerTypes.Circle },
    { label: "Bouncing Ball", value: SpinnerTypes.BouncingBall },
    { label: "Pulses", value: SpinnerTypes.Pulses },
    { label: "Typing", value: SpinnerTypes.Typing },
    { label: "Spinning Circle", value: SpinnerTypes.SpinningCircle },
    { label: "Spinning Circle (Simple)", value: SpinnerTypes.SpinningCircleSimple },
    { label: "Low Motion", value: SpinnerTypes.LowMotion },
];

const settings = definePluginSettings({
    spinnerType: {
        description: "Which loading animation Discord uses",
        type: OptionType.SELECT,
        options: SpinnerOptions,
        default: SpinnerTypes.WanderingCubes as string,
    },
    speed: {
        description: "Animation speed multiplier (0.5 = half speed, 2 = double speed)",
        type: OptionType.SLIDER,
        markers: [0.5, 0.75, 1, 1.5, 2, 3],
        stickToMarkers: true,
        default: 1,
    },
});

let injectedStyle: HTMLStyleElement | null = null;

function buildSpeedCss(speed: number): string {
    return `
/* BetterAnimations (Limey V1) — speed control */
[class*="spinner_"],
[class*="loading_"],
[class*="wanderingCubesItem_"],
[class*="spinnerItem_"] {
    animation-duration: calc(var(--ba-original-duration, 1.8s) / ${speed}) !important;
}
[class*="wanderingCubesItem_"],
[class*="spinnerItem_"] {
    animation-duration: calc(1.8s / ${speed}) !important;
}
`;
}

export default definePlugin({
    name: "BetterAnimations",
    description: "Change Discord's loading animations: pick a different spinner style and adjust the animation speed. Converted from the BetterDiscord plugin by arg0NNY.",
    tags: ["Appearance", "Utility"],
    authors: [Devs.Limey],
    settings,

    patches: [
        {
            // Discord's Spinner component picks the animation from module.Type keyed by spinner type
            find: '"WANDERING_CUBES"',
            replacement: {
                match: /=(\i)\.Type\[(\i)\]/,
                replace: "=$1.Type[$2] ?? ($2 === 'default' ? $self.spinnerOverride() : undefined)"
            }
        }
    ],

    spinnerOverride() {
        const selected = settings.store.spinnerType;
        if (!selected || selected === SpinnerTypes.WanderingCubes) return undefined;
        return SpinnerTypes[selected as keyof typeof SpinnerTypes];
    },

    start() {
        injectedStyle = document.createElement("style");
        injectedStyle.id = "limey-better-animations";
        document.head.appendChild(injectedStyle);
        this.applySpeed();
    },

    applySpeed() {
        if (injectedStyle) injectedStyle.textContent = buildSpeedCss(settings.store.speed ?? 1);
    },

    stop() {
        injectedStyle?.remove();
        injectedStyle = null;
    }
});

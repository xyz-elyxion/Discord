/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "DiscordEffects" by Deleox
 * (https://github.com/Deleox/BDPlugins) — re-implemented natively
 * for Limey V1. Original shooting star effect based on a CodePen
 * by Delroy Prithvi.
 *
 * Adds configurable ambient effects (shooting stars, snowflakes, rain)
 * over the Discord UI via an injected fixed-position overlay and CSS.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

type EffectType = "shootingStars" | "snowflakes" | "rain";

const settings = definePluginSettings({
    effect: {
        description: "Effect",
        type: OptionType.SELECT,
        options: [
            { label: "Shooting Stars", value: "shootingStars", default: true },
            { label: "Snowflakes", value: "snowflakes" },
            { label: "Rain", value: "rain" },
        ] as Array<{ label: string; value: EffectType; default?: boolean }>
    },
    spanCount: {
        description: "Span Count (more spans = more lag)",
        type: OptionType.SLIDER,
        markers: [0, 10, 20, 30, 40, 50],
        default: 10,
        stickToMarkers: true
    },
    zindexamount: {
        description: "Z-Index (lower this if the effect overlaps UI)",
        type: OptionType.NUMBER,
        default: 5
    },
    angle: {
        description: "Shooting Star Angle",
        type: OptionType.SLIDER,
        markers: [0, 90, 180, 270, 360],
        default: 315,
        stickToMarkers: true
    },
    flakecolor: {
        description: "Snowflake color",
        type: OptionType.STRING,
        default: "#ffffff"
    },
    flakeopacity: {
        description: "Snowflake opacity",
        type: OptionType.NUMBER,
        default: 0.5
    },
    flakemaxspeed: {
        description: "Max Snowflake Speed",
        type: OptionType.NUMBER,
        default: 15
    },
    raincolor: {
        description: "Rain color",
        type: OptionType.STRING,
        default: "#ffffff"
    },
    rainopacity: {
        description: "Rain opacity",
        type: OptionType.NUMBER,
        default: 0.5
    },
    rainmaxspeed: {
        description: "Max Rain Speed",
        type: OptionType.NUMBER,
        default: 0.5
    }
});

const OVERLAY_ID = "DiscordEffects";
const STYLE_ID = "DiscordEffectsStyle";

function generateSpanStyles(count: number, getStyles: (i: number) => string) {
    return Array.from({ length: count }, (_, i) =>
        `#DiscordEffects span:nth-child(${i + 1}) {\n${getStyles(i)}\n}`
    ).join("");
}

function generateRandomKeyframes(count: number) {
    return Array.from({ length: count }, (_, i) => `
        @keyframes randomPosition${i} {
            0% { left: ${Math.random() * 100}%; }
            100% { left: ${Math.random() * 100}%; }
        }
    `).join("");
}

function getEffectStyles(): string {
    const { effect, spanCount, angle, flakecolor, flakeopacity, raincolor, rainopacity, zindexamount } = settings.store as any;

    const shootingStarsStyles = (i: number) => `
        top: 0;
        right: ${80 * (i + 1)}px;
        left: ${Math.random() * 100}%;
        animation-delay: ${0.2 * i}s;
        animation-duration: ${1 + 0.25 * ((i % 4) + 1)}s;
    `;

    const snowflakesStyles = () => `
        left: ${Math.random() * 100}%;
        animation-delay: ${Math.random() * 5}s;
        animation-duration: ${5 + Math.random() * 5}s;
    `;

    const rainStyles = () => `
        left: ${Math.random() * 100}%;
        animation-delay: ${Math.random() * 1}s;
        animation-duration: ${0.5 + Math.random() * 1}s;
        overflow: hidden;
    `;

    switch (effect) {
        case "shootingStars":
            return `
                #DiscordEffects {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100vh;
                    pointer-events: none;
                    background-size: cover;
                    animation: animateBg 50s linear infinite;
                    z-index: ${zindexamount};
                }
                @keyframes animateBg {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.2); }
                }
                #DiscordEffects span {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    width: 4px;
                    height: 4px;
                    background: #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 0 4px rgba(255,255,255,0.1), 0 0 0 8px rgba(255,255,255,0.1), 0 0 20px rgba(255,255,255,0.1);
                    animation: animate 3s linear infinite;
                    transform-origin: top left;
                }
                #DiscordEffects span::before {
                    content: '';
                    position: absolute;
                    top: 50%;
                    transform: translateY(-50%);
                    width: 300px;
                    height: 1px;
                    background: linear-gradient(90deg, #fff, transparent);
                }
                @keyframes animate {
                    0% { transform: rotate(${angle}deg) translateX(0); opacity: 1; }
                    70% { opacity: 1; }
                    100% { transform: rotate(${angle}deg) translateX(-1000px); opacity: 0; }
                }
                ${generateSpanStyles(spanCount, shootingStarsStyles)}
            `;
        case "snowflakes":
            return `
                #DiscordEffects {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100vh;
                    pointer-events: none;
                    z-index: ${zindexamount};
                }
                #DiscordEffects span {
                    position: absolute;
                    top: -10px;
                    width: 10px;
                    height: 10px;
                    background: ${flakecolor || "white"};
                    opacity: ${flakeopacity ?? 0.8};
                    border-radius: 50%;
                    animation: fall 10s linear infinite;
                }
                @keyframes fall {
                    to { transform: translateY(100vh); opacity: 0; }
                }
                ${generateSpanStyles(spanCount, snowflakesStyles)}
            `;
        case "rain":
            return `
                #DiscordEffects {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100vh;
                    pointer-events: none;
                    z-index: ${zindexamount};
                }
                #DiscordEffects span {
                    position: absolute;
                    top: -10px;
                    width: 2px;
                    height: 20px;
                    background: ${raincolor || "linear-gradient(to bottom, rgba(255,255,255,0.5), rgba(255,255,255,0.1))"};
                    opacity: ${rainopacity ?? 0.6};
                    border-radius: 20%;
                    animation: fall 1s linear infinite;
                }
                @keyframes fall {
                    to { transform: translateY(100vh); opacity: 0; }
                }
                ${generateSpanStyles(spanCount, rainStyles)}
                ${generateRandomKeyframes(spanCount)}
            `;
        default:
            return "";
    }
}

function removeSection() {
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(STYLE_ID)?.remove();
}

function addSection() {
    removeSection();

    const { effect, spanCount, flakecolor, flakeopacity, flakemaxspeed, raincolor, rainopacity, rainmaxspeed, zindexamount } = settings.store as any;

    const section = document.createElement("div");
    section.id = OVERLAY_ID;
    section.style.zIndex = String(zindexamount ?? 5);

    for (let i = 0; i < (spanCount ?? 10); i++) {
        const span = document.createElement("span");
        span.style.position = "absolute";
        if (effect === "snowflakes") {
            span.style.top = "-10px";
            span.style.width = "10px";
            span.style.height = "10px";
            span.style.background = flakecolor || "white";
            span.style.opacity = String(flakeopacity ?? 0.5);
            span.style.borderRadius = "50%";
            span.style.left = `${Math.random() * 100}%`;
            span.style.animationDelay = `${Math.random() * 5}s`;
            span.style.animationDuration = `${Math.random() * (flakemaxspeed ?? 15)}s`;
            span.style.animationName = "fall";
            span.style.animationIterationCount = "infinite";
            span.style.animationTimingFunction = "linear";
        } else if (effect === "rain") {
            span.style.top = "-10px";
            span.style.width = "2px";
            span.style.height = "20px";
            span.style.background = raincolor || "linear-gradient(to bottom, rgba(255, 255, 255, 1), rgba(255, 255, 255, 0.2))";
            span.style.opacity = String(rainopacity ?? 0.5);
            span.style.borderRadius = "20%";
            span.style.left = `${Math.random() * 100}%`;
            span.style.animationDelay = `${Math.random() * 1}s`;
            span.style.animationDuration = `${Math.random() * (rainmaxspeed ?? 0.5)}s`;
            span.style.animationName = "fall";
            span.style.animationIterationCount = "infinite";
            span.style.animationTimingFunction = "linear";
        }
        section.appendChild(span);
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = getEffectStyles();
    document.head.appendChild(style);

    (document.getElementById("app-mount") ?? document.body).appendChild(section);
}

export default definePlugin({
    name: "DiscordEffects",
    description: "Adds ambient effects to your Discord: shooting stars, snowflakes or rain. Converted from the BetterDiscord plugin by Deleox.",
    tags: ["Fun", "Customisation"],
    authors: [Devs.Limey],
    settings,

    start() {
        addSection();
    },

    stop() {
        removeSection();
    },

    settingsAboutComponent: () => null,
}) as any;

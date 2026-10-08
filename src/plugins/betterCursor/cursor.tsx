/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Flex } from "@components/Flex";
import { Paragraph } from "@components/Paragraph";

export const CHANGELOG = [
    {
        version: "1.1.1",
        date: "2026-10-08",
        entries: [
            "Cursor now inverts with your theme: dark ink on light themes, white on dark themes, using Discord's own text/surface colors."
        ]
    },
    {
        version: "1.1.0",
        date: "2026-10-08",
        entries: [
            "Cursor now scales with screen size (scales down on small windows).",
            "Click effect: quick squash on every mouse click.",
            "Cursor colors follow Discord's theme (dark/light/brand color) automatically.",
            "System cursor is now hidden over buttons and all other elements, not just the page background."
        ]
    },
    {
        version: "1.0.0",
        date: "2026-10-08",
        entries: [
            "Initial release: spring-animated cursor with velocity-based rotation.",
            "Adjustable trail strength and cursor size from plugin settings.",
            "Optional hide of the system cursor while active."
        ]
    }
] as const;

export function CursorChangelog() {
    return (
        <Flex flexDirection="column" gap=".5em">
            <BaseText size="md" weight="bold">BetterCursor Changelog</BaseText>
            {CHANGELOG.map(({ version, date, entries }) => (
                <div key={version} style={{ marginBottom: 8 }}>
                    <Paragraph style={{ fontWeight: 600 }}>
                        v{version} <span style={{ opacity: 0.6, fontWeight: 400 }}>— {date}</span>
                    </Paragraph>
                    <ul style={{ margin: "4px 0 0 18px", listStyle: "disc" }}>
                        {entries.map(entry => (
                            <li key={entry}><Paragraph>{entry}</Paragraph></li>
                        ))}
                    </ul>
                </div>
            ))}
        </Flex>
    );
}

const SVG_PATH_SHADOW = "M42.6817 41.1495L27.5103 6.79925C26.7269 5.02557 24.2082 5.02558 23.3927 6.79925L7.59814 41.1495C6.75833 42.9759 8.52712 44.8902 10.4125 44.1954L24.3757 39.0496C24.8829 38.8627 25.4385 38.8627 25.9422 39.0496L39.8121 44.1954C41.6849 44.8902 43.4884 42.9759 42.6817 41.1495Z";
const SVG_PATH_OUTLINE = "M43.7146 40.6933L28.5431 6.34306C27.3556 3.65428 23.5772 3.69516 22.3668 6.32755L6.57226 40.6778C5.3134 43.4156 7.97238 46.298 10.803 45.2549L24.7662 40.109C25.0221 40.0147 25.2999 40.0156 25.5494 40.1082L39.4193 45.254C42.2261 46.2953 44.9254 43.4347 43.7146 40.6933Z";

// --- Spring physics overlay (no external animation library) -------------------

interface SpringConfig {
    stiffness: number;
    damping: number;
    mass: number;
}

export interface CursorOptions {
    trailStrength: number;
    size: number;
    hideSystemCursor: boolean;
}

const DEFAULT_CONFIG: SpringConfig = { stiffness: 400, damping: 45, mass: 1 };

class SpringValue {
    value = 0;
    velocity = 0;
    target = 0;

    constructor(private config: SpringConfig) { }

    set(target: number) {
        this.target = target;
    }

    step(dt: number) {
        const { stiffness, damping, mass } = this.config;
        const force = -stiffness * (this.value - this.target);
        const friction = -damping * this.velocity;
        this.velocity += ((force + friction) / mass) * dt;
        this.value += this.velocity * dt;
    }
}

let container: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let rafId = 0;
let lastTime = 0;
let resting = false;
let currentOptions: CursorOptions | null = null;

const posX = new SpringValue(DEFAULT_CONFIG);
const posY = new SpringValue(DEFAULT_CONFIG);
const rotation = new SpringValue({ stiffness: 300, damping: 60, mass: 1 });
const scale = new SpringValue({ stiffness: 500, damping: 35, mass: 1 });
const clickScale = new SpringValue({ stiffness: 700, damping: 22, mass: 1 });

let lastMouse = { x: 0, y: 0 };
let lastVelocity = { x: 0, y: 0 };
let lastMoveTime = 0;
let prevAngle = 0;
let accumulatedRotation = 0;
let screenScale = 1;

/**
 * Scale the cursor relative to window size: 1280px wide = 1.0x, growing to
 * ~1.25x on very large screens and shrinking to ~0.7x on small windows.
 */
function computeScreenScale() {
    const width = window.innerWidth;
    // piecewise-linear: 0.7x at 600px, 1.0x at 1280px, 1.25x at 2560px+
    if (width <= 1280) {
        screenScale = 0.7 + (width - 600) / (1280 - 600) * 0.3;
    } else {
        screenScale = 1 + Math.min(0.25, (width - 1280) / 2560 * 0.25);
    }
    screenScale = Math.max(0.55, Math.min(1.3, screenScale));
}

function applyThemeColors() {
    if (!shadowRoot) return;
    const styles = getComputedStyle(document.body);
    const isLight = document.body.classList.contains("theme-light")
        || styles.getPropertyValue("--theme").trim() === "light"
        || styles.colorScheme === "light";

    // Match the theme: use Discord's text color for the fill so the cursor
    // always contrasts with the background (dark ink on light theme, white
    // on dark theme), with the theme's surface color as the outline.
    const fill = styles.getPropertyValue("--text-default").trim()
        || styles.getPropertyValue("--interactive-normal").trim()
        || (isLight ? "#060607" : "#ffffff");
    const outline = styles.getPropertyValue("--background-base-low").trim()
        || (isLight ? "#ffffff" : "#1e1f22");

    const svg = shadowRoot.querySelector("svg");
    const paths = svg?.querySelectorAll("path");
    if (paths && paths.length >= 2) {
        paths[0].setAttribute("fill", fill);
        paths[1].setAttribute("stroke", outline);
    }
}

function onMouseMove(e: MouseEvent) {
    const now = Date.now();
    const dt = Math.max(1, now - lastMoveTime);
    lastVelocity = {
        x: (e.clientX - lastMouse.x) / dt,
        y: (e.clientY - lastMouse.y) / dt
    };
    lastMouse = { x: e.clientX, y: e.clientY };
    lastMoveTime = now;

    posX.set(e.clientX);
    posY.set(e.clientY);

    const speed = Math.hypot(lastVelocity.x, lastVelocity.y);
    if (speed > 0.1) {
        const angle = Math.atan2(lastVelocity.y, lastVelocity.x) * (180 / Math.PI) + 90;
        let diff = angle - prevAngle;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        accumulatedRotation += diff;
        rotation.set(accumulatedRotation);
        prevAngle = angle;

        scale.set(0.95);
    }
}

function onMouseDown() {
    clickScale.set(0.78);
}

function onMouseUp() {
    clickScale.set(1);
}

function frame(time: number) {
    if (!container) return;
    const dt = Math.min(0.05, lastTime ? (time - lastTime) / 1000 : 0.016);
    lastTime = time;

    posX.step(dt);
    posY.step(dt);
    rotation.step(dt);
    scale.step(dt);
    clickScale.step(dt);

    // ease scale back to 1 when the mouse stops
    if (Date.now() - lastMoveTime > 150) scale.set(1);

    // fade out while resting to avoid a stray cursor at (0,0)
    const isResting = Date.now() - lastMoveTime > 4000;
    if (isResting !== resting) {
        resting = isResting;
        container.style.opacity = isResting ? "0" : "1";
    }

    const totalScale = screenScale * clickScale.value;
    container.style.transform =
        `translate(${posX.value}px, ${posY.value}px) rotate(${rotation.value}deg) scale(${totalScale})`;

    rafId = requestAnimationFrame(frame);
}

let themeObserver: MutationObserver | null = null;
const resizeHandler = () => computeScreenScale();
const mouseDownHandler = onMouseDown;
const mouseUpHandler = onMouseUp;

export const CursorOverlay = {
    mount(options: CursorOptions) {
        if (container) return;
        currentOptions = options;
        container = document.createElement("div");
        container.id = "better-cursor-overlay";
        Object.assign(container.style, {
            position: "fixed",
            left: "0",
            top: "0",
            zIndex: "9999",
            pointerEvents: "none",
            willChange: "transform",
            transformOrigin: "center",
            translate: "-50% -50%"
        });
        document.body.append(container);

        shadowRoot = container.attachShadow({ mode: "open" });
        const host = document.createElement("div");
        host.style.transform = `scale(${options.size / 50})`;
        shadowRoot.append(host);

        // inject the SVG markup directly (Shadow DOM + React portals don't mix)
        const svgHost = document.createElement("div");
        host.append(svgHost);
        svgHost.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="50" height="54" viewBox="0 0 50 54" fill="none">
                <g filter="url(#betterCursorShadow)">
                    <path d="${SVG_PATH_SHADOW}" fill="#313338" />
                    <path d="${SVG_PATH_OUTLINE}" stroke="#e3e5e8" stroke-width="2.25825" />
                </g>
                <defs>
                    <filter id="betterCursorShadow" x="0.6" y="0.95" width="49.1" height="52.4" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
                        <feFlood flood-opacity="0" result="bgFix"/>
                        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
                        <feOffset dy="2.25825"/>
                        <feGaussianBlur stdDeviation="2.25825"/>
                        <feComposite in2="hardAlpha" operator="out"/>
                        <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.08 0"/>
                        <feBlend mode="normal" in2="bgFix" result="drop"/>
                        <feBlend mode="normal" in="SourceGraphic" in2="drop"/>
                    </filter>
                </defs>
            </svg>
        `;

        // fit Discord's current theme
        applyThemeColors();
        themeObserver = new MutationObserver(applyThemeColors);
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });

        // resize with the window
        computeScreenScale();
        window.addEventListener("resize", resizeHandler);

        // click effect
        window.addEventListener("mousedown", mouseDownHandler);
        window.addEventListener("mouseup", mouseUpHandler);

        if (options.hideSystemCursor) {
            // universal + important so it wins over Discord's own cursor rules
            // on buttons, links, inputs, etc.
            const style = document.createElement("style");
            style.id = "better-cursor-hide";
            style.textContent = "* { cursor: none !important; }";
            document.head.append(style);
        }

        window.addEventListener("mousemove", onMouseMove);
        rafId = requestAnimationFrame(frame);
    },

    unmount() {
        if (!container) return;
        cancelAnimationFrame(rafId);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("resize", resizeHandler);
        window.removeEventListener("mousedown", mouseDownHandler);
        window.removeEventListener("mouseup", mouseUpHandler);
        themeObserver?.disconnect();
        themeObserver = null;
        document.getElementById("better-cursor-hide")?.remove();
        container.remove();
        container = null;
        shadowRoot = null;
        document.body.style.cursor = "auto";
    }
};

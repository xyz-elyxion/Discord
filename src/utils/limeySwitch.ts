/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Global "Limey V1 is off" switch and the notice that lets the user turn it
 * back on.
 *
 * This module is deliberately tiny and dependency-free: it has to work while
 * Limey V1 is otherwise inert (no plugins started, no styles, no
 * notifications), so it must not import anything that touches webpack, React
 * or Discord's modules. The state lives in localStorage (synchronous) so the
 * boot can check it before any async work happens.
 */

const DISABLE_KEY = "LimeyV1Disabled";

function getPageStorage() {
    try {
        // NOTE: window.localStorage is used explicitly. In the userscript build
        // `window` is mapped to unsafeWindow, so this always resolves to the
        // page's own storage — the same storage the next boot reads the flag
        // from — even inside a sandboxed userscript.
        return window.localStorage;
    } catch {
        return null;
    }
}

export function isLimeyDisabled() {
    return getPageStorage()?.getItem(DISABLE_KEY) === "true";
}

export function setLimeyDisabled(disabled: boolean) {
    try {
        if (disabled) {
            getPageStorage()?.setItem(DISABLE_KEY, "true");
        } else {
            getPageStorage()?.removeItem(DISABLE_KEY);
        }
    } catch {
        // no storage access (very odd) — Limey V1 simply stays on
    }
}

const OFF_NOTICE_ID = "vc-limey-off-notice";

/**
 * Small corner card shown whenever Limey V1 boots while turned off. It keeps
 * the "Turn back on" affordance reachable from inside Discord even though
 * none of Limey V1's own UI is running.
 */
export function installLimeyOffNotice() {
    if (typeof document === "undefined" || document.getElementById(OFF_NOTICE_ID)) return;

    const mount = () => {
        if (document.getElementById(OFF_NOTICE_ID)) return;

        const card = document.createElement("div");
        card.id = OFF_NOTICE_ID;
        card.style.cssText = [
            "position: fixed",
            "bottom: 20px",
            "right: 20px",
            "z-index: 2147483646",
            "display: flex",
            "align-items: center",
            "gap: 12px",
            "padding: 12px 14px",
            "background: #1e1f22",
            "color: #dbdee1",
            "border: 1px solid #313338",
            "border-radius: 8px",
            "box-shadow: 0 8px 24px rgba(0, 0, 0, .45)",
            "font: 500 13.5px/1.35 'gg sans', 'Noto Sans', system-ui, sans-serif"
        ].join(";");

        const label = document.createElement("span");
        label.textContent = "Limey V1 is off.";

        const button = document.createElement("button");
        button.textContent = "Turn back on";
        button.style.cssText = [
            "background: #a3e635",
            "border: none",
            "color: #1a2e05",
            "cursor: pointer",
            "padding: 7px 12px",
            "border-radius: 4px",
            "font: 600 13px 'gg sans', 'Noto Sans', system-ui, sans-serif"
        ].join(";");
        button.addEventListener("click", () => {
            setLimeyDisabled(false);
            // The renderer scripts are re-injected on every page load, so a
            // reload brings Limey V1 back without needing a full app relaunch.
            window.location.reload();
        });

        card.append(label, button);
        document.body.appendChild(card);
    };

    if (document.body) {
        mount();
    } else {
        document.addEventListener("DOMContentLoaded", mount, { once: true });
    }
}

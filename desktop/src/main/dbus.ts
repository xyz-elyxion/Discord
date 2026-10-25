/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app } from "electron";
import { join } from "path";
import { STATIC_DIR } from "shared/paths";

let libLimeyDesktop: typeof import("liblimey") | null = null;

function loadLibLimeyDesktop() {
    try {
        if (!libLimeyDesktop) {
            libLimeyDesktop = require(join(STATIC_DIR, `dist/liblimey-${process.arch}.node`));
        }
    } catch (e) {
        console.error("Failed to load liblimey:", e);
    }

    return libLimeyDesktop;
}

export function getAccentColor() {
    return loadLibLimeyDesktop()?.getAccentColor() ?? null;
}

export function updateUnityLauncherCount(count: number) {
    const libLimeyDesktop = loadLibLimeyDesktop();
    if (!libLimeyDesktop) {
        return app.setBadgeCount(count);
    }

    return libLimeyDesktop.updateUnityLauncherCount(count);
}

export function requestBackground(autoStart: boolean, commandLine: string[]) {
    return loadLibLimeyDesktop()?.requestBackground(autoStart, commandLine) ?? false;
}

/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync } from "fs";
import { access, constants as FsConstants, writeFile } from "fs/promises";
import { join } from "path";

import { LIMEY_FILES_DIR } from "main/limeyFilesDir";

import { USER_AGENT } from "../constants";
import { downloadFile } from "./http";

// Limey V1 builds live on the Limey backend (same source of truth the
// Limey installer pulls from, hash-stamped per build). Override the base
// URL with LIMEY_DESKTOP_BASE_URL for local/staging testing.
const BASE_URL = (process.env.LIMEY_DESKTOP_BASE_URL || "https://limey-discord.onrender.com").replace(/\/+$/, "");

export const FILES_TO_DOWNLOAD = [
    "limeyV1DesktopMain.js",
    "limeyV1DesktopPreload.js",
    "limeyV1DesktopRenderer.js",
    "limeyV1DesktopRenderer.css"
];

const existsAsync = (path: string) =>
    access(path, FsConstants.F_OK)
        .then(() => true)
        .catch(() => false);

export async function downloadLimeyFiles() {
    for (const name of FILES_TO_DOWNLOAD) {
        const url = `${BASE_URL}/v1/install/files/${name}`;
        const file = join(LIMEY_FILES_DIR, name);

        for (let tries = 0; ; tries++) {
            try {
                await downloadFile(url, file, { headers: { "User-Agent": USER_AGENT } }, { retryOnNetworkError: true });
                break;
            } catch (err) {
                if (tries >= 2) throw err;
                console.error(`Failed to download ${name}, retrying...`, err);
            }
        }
    }
}

export async function isValidLimeyV1Install(dir: string) {
    const results = await Promise.all(FILES_TO_DOWNLOAD.map(f => existsAsync(join(dir, f))));
    return !results.includes(false);
}

export async function ensureLimeyFiles() {
    // Keep existing files unless --repair is used, so the client keeps
    // running from the last good copy while the backend is unreachable.
    if (process.env.LIMEY_REPAIR !== "1" && (await isValidLimeyV1Install(LIMEY_FILES_DIR))) return;

    mkdirSync(LIMEY_FILES_DIR, { recursive: true });

    await Promise.all([downloadLimeyFiles(), writeFile(join(LIMEY_FILES_DIR, "package.json"), "{}")]);
}

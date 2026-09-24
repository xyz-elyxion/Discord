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

import { fetchBuffer } from "@main/utils/http";
import { IpcEvents } from "@shared/IpcEvents";
import { ipcMain } from "electron";
import { writeFile } from "fs/promises";
import { join } from "path";

import gitHash from "~git-hash";

import { LIMEYV1_FILES, serializeErrors } from "./common";

// All updates come from the Limey V1 backend. Every served build file is
// stamped with a first-line version comment ("// Limey V1 <hash>"), the same
// stamp the installer uses to detect installed vs latest builds.
const LIMEY_BASE = "https://limey-discord.onrender.com";
const VERSION_FILE = "renderer.css";
// The stamp on js files is a comment; on css it is wrapped in slashes.
const HASH_STAMP_CSS = "/* Limey ";

let PendingUpdates = [] as string[];

function fileUrl(name: string) {
    return `${LIMEY_BASE}/v1/install/files/${name}`;
}

async function fetchLatestHash() {
    const res = await fetchBuffer(fileUrl(VERSION_FILE));
    const firstLine = new TextDecoder().decode(res).split("\n", 1)[0].trim();

    if (!firstLine.startsWith(HASH_STAMP_CSS)) {
        throw new Error("Could not determine latest build hash from the Limey V1 backend");
    }
    const hash = firstLine.slice(HASH_STAMP_CSS.length).replace(/\*\/$/, "").trim();
    if (!hash) throw new Error("Could not determine latest build hash from the Limey V1 backend");

    if (!hash) throw new Error("Could not determine latest build hash from the Limey V1 backend");
    return hash;
}

async function calculateGitChanges() {
    const isOutdated = await fetchUpdates();
    if (!isOutdated) return [];

    // No diff data is available from the backend; report a single change entry.
    return [{
        hash: "update",
        author: "Limey V1",
        message: "New Limey V1 build available on limey-discord.onrender.com"
    }];
}

async function fetchUpdates() {
    const hash = await fetchLatestHash();
    if (hash === gitHash) return false;

    PendingUpdates = [...LIMEYV1_FILES];
    return true;
}

async function applyUpdates() {
    const fileContents = await Promise.all(PendingUpdates.map(async name => {
        const contents = await fetchBuffer(fileUrl(name));
        return [join(__dirname, name), contents] as const;
    }));

    await Promise.all(fileContents.map(async ([filename, contents]) =>
        writeFile(filename, contents))
    );

    PendingUpdates = [];
    return true;
}

ipcMain.handle(IpcEvents.GET_REPO, serializeErrors(() => LIMEY_BASE));
ipcMain.handle(IpcEvents.GET_UPDATES, serializeErrors(calculateGitChanges));
ipcMain.handle(IpcEvents.UPDATE, serializeErrors(fetchUpdates));
ipcMain.handle(IpcEvents.BUILD, serializeErrors(applyUpdates));

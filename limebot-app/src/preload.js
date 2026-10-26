/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* Narrow bridge between the sandboxed window and the main process. */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("limebot", {
    state: () => ipcRenderer.invoke("app:state"),
    logs: () => ipcRenderer.invoke("app:logs"),
    saveToken: token => ipcRenderer.invoke("app:save-token", token),
    start: token => ipcRenderer.invoke("bot:start", token),
    stop: () => ipcRenderer.invoke("bot:stop"),
    restart: () => ipcRenderer.invoke("bot:restart"),
    chooseDir: () => ipcRenderer.invoke("bot:choose-dir"),
    resetDir: () => ipcRenderer.invoke("bot:reset-dir"),
    openLogs: () => ipcRenderer.invoke("app:open-logs"),
    openExternal: url => ipcRenderer.invoke("app:open-external", url),
    recheckNode: () => ipcRenderer.invoke("app:recheck-node"),

    onLog: callback => {
        const listener = (_event, entry) => callback(entry);
        ipcRenderer.on("bot:log", listener);
        return () => ipcRenderer.removeListener("bot:log", listener);
    },
    onState: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on("bot:state", listener);
        return () => ipcRenderer.removeListener("bot:state", listener);
    }
});

/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Electron shell for the Limebot desktop app.
 *
 * Volunteers get one window: paste the bot token, press Start, watch the log.
 * Everything the bot needs is bundled with the app (a filtered copy of bot/)
 * and unpacked into the app's user-data folder on first run, because run.js
 * writes node_modules/ and dist/ next to itself and the application bundle is
 * read-only on Windows and macOS.
 */

"use strict";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { BotSupervisor, checkNode } = require("./core");

if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
}

const userDataDir = () => app.getPath("userData");
const settingsFile = () => path.join(userDataDir(), "settings.json");
const logFile = () => path.join(userDataDir(), "logs", "limebot.log");
const runtimeDir = () => path.join(userDataDir(), "limebot-runtime");

/** @type {{ token: string, botDir: string | null }} */
let settings = { token: "", botDir: null };
/** @type {BotSupervisor} */
let supervisor;
/** @type {BrowserWindow | null} */
let window = null;
let managedRuntime = false;
let nodeInfo = checkNode();

// --- settings ---------------------------------------------------------------

function readSettings() {
    try {
        const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
        return {
            token: typeof raw.token === "string" ? raw.token : "",
            botDir: typeof raw.botDir === "string" && raw.botDir ? raw.botDir : null
        };
    } catch {
        return { token: "", botDir: null };
    }
}

function writeSettings() {
    try {
        fs.mkdirSync(userDataDir(), { recursive: true });
        fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 4), { mode: 0o600 });
        // writeFileSync only applies the mode when creating; enforce it anyway
        // so an existing file with looser permissions gets tightened too.
        if (process.platform !== "win32") fs.chmodSync(settingsFile(), 0o600);
    } catch (error) {
        console.error("[limebot-app] could not save settings:", error);
    }
}

// --- bot folder -------------------------------------------------------------

function hasRunJs(dir) {
    try {
        return fs.statSync(path.join(dir, "run.js")).isFile();
    } catch {
        return false;
    }
}

function bundledBotDir() {
    if (!app.isPackaged) return null;
    return path.join(process.resourcesPath, "bot");
}

/** Copy the bundled bot source over the runtime folder, keeping node_modules/. */
function unpackBundledBot(from, to) {
    const skip = new Set(["node_modules", "dist", "data", ".git"]);

    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, {
        recursive: true,
        force: true,
        filter: source => {
            const relative = path.relative(from, source);
            if (!relative) return true;
            const [top] = relative.split(path.sep);
            if (skip.has(top)) return false;
            if (relative === ".env") return false;
            return true;
        }
    });
}

/**
 * Decide which copy of the bot to run:
 *  1. a folder the volunteer picked by hand,
 *  2. the copy bundled into the app (unpacked into user data, refreshed when
 *     the app version changes so updates ship the new bot source),
 *  3. a sibling `bot/` checkout, which is how the app runs from the repo.
 */
function resolveBotDir() {
    if (settings.botDir && hasRunJs(settings.botDir)) {
        managedRuntime = false;
        return settings.botDir;
    }

    const bundled = bundledBotDir();
    if (bundled && hasRunJs(bundled)) {
        const target = runtimeDir();
        const marker = path.join(target, ".limebot-app-version");
        let installedVersion = "";
        try {
            installedVersion = fs.readFileSync(marker, "utf8").trim();
        } catch {
            // First run — nothing unpacked yet.
        }

        if (installedVersion !== app.getVersion() || !hasRunJs(target)) {
            try {
                unpackBundledBot(bundled, target);
                fs.writeFileSync(marker, app.getVersion());
            } catch (error) {
                console.error("[limebot-app] could not unpack the bundled bot:", error);
            }
        }

        managedRuntime = true;
        return target;
    }

    const sibling = path.resolve(__dirname, "..", "..", "bot");
    managedRuntime = false;
    return hasRunJs(sibling) ? sibling : runtimeDir();
}

function createSupervisor(botDir) {
    const next = new BotSupervisor({ botDir, logFile: logFile() });

    next.on("log", entry => window?.webContents.send("bot:log", entry));
    next.on("state", state => window?.webContents.send("bot:state", state));

    return next;
}

// --- IPC surface ------------------------------------------------------------

function currentState() {
    return {
        ...supervisor.snapshot(),
        token: settings.token,
        node: nodeInfo,
        managed: managedRuntime,
        logFile: logFile(),
        version: app.getVersion()
    };
}

function registerIpc() {
    ipcMain.handle("app:state", () => currentState());

    ipcMain.handle("app:logs", () => supervisor.recentLines());

    ipcMain.handle("app:save-token", (_event, token) => {
        settings.token = String(token ?? "").trim();
        writeSettings();
        return currentState();
    });

    ipcMain.handle("bot:start", (_event, token) => {
        const trimmed = String(token ?? "").trim();
        if (trimmed) {
            settings.token = trimmed;
            writeSettings();
        }

        const result = supervisor.start(settings.token);
        return { ...currentState(), error: result.ok ? null : result.error };
    });

    ipcMain.handle("bot:stop", () => {
        supervisor.stop();
        return currentState();
    });

    ipcMain.handle("bot:restart", () => {
        const result = supervisor.restart(settings.token);
        return { ...currentState(), error: result.ok ? null : result.error };
    });

    ipcMain.handle("bot:choose-dir", async () => {
        const picked = await dialog.showOpenDialog(window, {
            title: "Select the bot folder (the one containing run.js)",
            properties: ["openDirectory"],
            defaultPath: supervisor.botDir
        });

        if (picked.canceled || !picked.filePaths.length) return currentState();

        const dir = picked.filePaths[0];
        if (!hasRunJs(dir)) {
            await dialog.showMessageBox(window, {
                type: "error",
                message: "That folder does not contain run.js",
                detail: "Pick the bot/ folder of the Limebot repository.",
                buttons: ["OK"]
            });
            return currentState();
        }

        if (supervisor.running) supervisor.stop();

        settings.botDir = dir;
        writeSettings();
        supervisor = createSupervisor(resolveBotDir());
        return currentState();
    });

    ipcMain.handle("bot:reset-dir", () => {
        if (supervisor.running) supervisor.stop();
        settings.botDir = null;
        writeSettings();
        supervisor = createSupervisor(resolveBotDir());
        return currentState();
    });

    ipcMain.handle("app:open-logs", async () => {
        const dir = path.dirname(logFile());
        fs.mkdirSync(dir, { recursive: true });
        await shell.openPath(dir);
    });

    ipcMain.handle("app:open-external", (_event, url) => {
        const allowed = ["https://nodejs.org/", "https://discord.com/developers/applications"];
        if (typeof url === "string" && allowed.some(prefix => url.startsWith(prefix))) {
            return shell.openExternal(url);
        }
        return Promise.resolve();
    });

    ipcMain.handle("app:recheck-node", () => {
        nodeInfo = checkNode();
        return currentState();
    });
}

// --- window -----------------------------------------------------------------

function createWindow() {
    window = new BrowserWindow({
        width: 1000,
        height: 720,
        minWidth: 720,
        minHeight: 520,
        backgroundColor: "#1b1b21",
        title: "Limebot",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    window.once("ready-to-show", () => window?.show());
    window.loadFile(path.join(__dirname, "renderer", "index.html"));
    window.on("closed", () => { window = null; });

    // The window owns the child process: closing it stops the bot rather than
    // leaving an orphaned node process behind.
    window.on("close", () => supervisor?.dispose());
}

app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
});

app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    settings = readSettings();
    supervisor = createSupervisor(resolveBotDir());
    registerIpc();
    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    supervisor?.dispose();
    app.quit();
});

app.on("before-quit", () => supervisor?.dispose());

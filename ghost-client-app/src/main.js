/*
 * Limey V1 Ghost Client — overlay main process.
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Creates the Prestige-style GUI window: frameless, transparent and
 * always-on-top so it floats above the Discord client where Limey V1 is
 * installed. All content is rendered in the renderer (overlay GUI); the
 * main process only owns the window, position persistence and the
 * click-through lock.
 */
"use strict";

const {
    app,
    BrowserWindow,
    globalShortcut,
    ipcMain,
    screen,
    Tray,
    Menu,
    nativeImage,
} = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join, dirname } = require("path");

const CONFIG_DIR = join(app.getPath("userData"), "config");
const CONFIG_FILE = join(CONFIG_DIR, "ghost.json");

let win = null;
let tray = null;
let clickThrough = false;

function readConfig() {
    try {
        return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
        return { x: 0, y: 0, width: 420, height: 520, clickThrough: false };
    }
}

function saveConfig(patch) {
    const next = { ...readConfig(), ...patch };
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    } catch { /* best effort */ }
}

function createWindow() {
    const cfg = readConfig();
    const workArea = screen.getPrimaryDisplay().workArea;

    const width = Math.min(cfg.width || 420, workArea.width);
    const height = Math.min(cfg.height || 520, workArea.height);
    const x = Number.isFinite(cfg.x) ? cfg.x : Math.max(0, workArea.width - width - 24);
    const y = Number.isFinite(cfg.y) ? cfg.y : 24;

    win = new BrowserWindow({
        width,
        height,
        x,
        y,
        minWidth: 300,
        minHeight: 200,
        // Prestige-style: see Discord behind it, no frame, no shadow.
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: true,
        skipTaskbar: false,
        alwaysOnTop: true,
        backgroundColor: "#00000000",
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            backgroundThrottling: false
        }
    });

    // Float above everything, even Discord's own always-on-top windows.
    win.setAlwaysOnTop(true, "screen-saver");
    win.setMenu(null);

    setClickThrough(Boolean(cfg.clickThrough));

    // Persist position/size when the user drags or resizes the overlay.
    const persistBounds = () => {
        if (!win) return;
        const [w, h] = win.getSize();
        const [x, y] = win.getPosition();
        saveConfig({ x, y, width: w, height: h });
    };
    win.on("moved", persistBounds);
    win.on("resized", persistBounds);

    win.on("closed", () => {
        win = null;
    });

    win.loadFile(join(__dirname, "renderer", "index.html"));
}

/** Click-through lets you use Discord normally through the overlay. */
function setClickThrough(on) {
    if (!win) return;
    clickThrough = on;
    // "-1" means forward every click through the window except when the
    // forward() of the previous state is triggered by the renderer.
    win.setIgnoreMouseEvents(on, { forward: !on });
    // Keep the OS-level flag so the overlay never steals focus while
    // click-through is active.
    win.setFocusable(!on);
    saveConfig({ clickThrough: on });
    win.webContents.send("click-through-set", on);
}

function createTray() {
    // 1x1 transparent PNG keeps the tray functional without shipping an asset.
    const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYGD4DwABBAEAX+jGOgAAAABJRUE5CYII=",
        "base64"
    );
    tray = new Tray(nativeImage.createFromBuffer(png, { width: 1, height: 1 }));
    Menu.setApplicationMenu(null);
    tray.setToolTip("Limey V1 Ghost Client");
    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: "Show / Hide overlay",
            click: () => {
                if (!win) return createWindow();
                win.isVisible() ? win.hide() : win.show();
            }
        },
        {
            label: clickThrough ? "Disable click-through" : "Enable click-through",
            click: () => setClickThrough(!clickThrough)
        },
        { type: "separator" },
        {
            label: "Quit Ghost Client",
            click: () => app.quit()
        }
    ]));
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    globalShortcut.register("Shift+F9", () => {
        if (win) win.isVisible() ? win.hide() : win.show();
    });
    globalShortcut.register("Shift+F10", () => setClickThrough(!clickThrough));

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    // Keep running in the tray like a real client mod companion.
    if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
    globalShortcut.unregisterAll();
});

// Renderer asks main to toggle mouse events (the GUI has a lock button too).
ipcMain.on("set-click-through", (_event, on) => setClickThrough(Boolean(on)));
ipcMain.on("quit-app", () => app.quit());
ipcMain.handle("win-flash", () => {
    if (win) win.flashFrame(true);
});

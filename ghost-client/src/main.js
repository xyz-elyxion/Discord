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
const { spawn } = require("child_process");

const CONFIG_DIR = join(app.getPath("userData"), "config");
const CONFIG_FILE = join(CONFIG_DIR, "ghost.json");

let win = null;
let tray = null;
let clickThrough = false;

// ---- ESP mode ------------------------------------------------------------
// ESP is the original "ghost client" trick: instead of drawing the plugin
// effects inside a separate GUI panel, we pin a transparent click-through
// canvas window exactly over the Discord client window and draw the effects
// at the live screen position of the Discord UI elements they belong to
// (like a game overlay drawing ESP marks on top of the real players).
// Positions come from the Limey V1 Goldpin relay: the plugin inside Discord
// measures its own effect markers and relays them; we only handle the window
// snapping. Windows-only (Win32 window rect lookup).
let espEnabled = false;
let espWin = null;
let espAlignTimer = null;
let lastGhostState = null;

// Win32 lookup: enumerate ALL visible top-level windows whose class is an
// Electron/Chromium shell ('Chrome_WidgetWin_1') or Firefox
// ('MozillaWindowClass') and whose title looks like the modded client
// ('Limey V1 Desktop' fork, or '… Discord' when Limey V1 runs in the WEB
// version inside a browser/PWA tab). Skip our own overlay + minimized windows
// and return each candidate's screen rect in physical pixels.
const POWERSHELL_WINDOW_LOOKUP = `
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public class LimWin2 {
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder n, int c);
    [DllImport("user32.dll")] public static extern bool GetWindowText(IntPtr h, System.Text.StringBuilder n, int c);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out LimWin2.R r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public struct R { public int L; public int T; public int Rt; public int B; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
}
'@
$found = New-Object System.Collections.Generic.List[string]
$cb = [LimWin2+EnumProc]{
    param($h, $l)
    try {
        if (-not [LimWin2]::IsWindowVisible($h)) { return $true }
        $cn = New-Object System.Text.StringBuilder 256
        [void][LimWin2]::GetClassName($h, $cn, 256)
        $cls = $cn.ToString()
        if ($cls -ne 'Chrome_WidgetWin_1' -and $cls -ne 'MozillaWindowClass') { return $true }
        $tt = New-Object System.Text.StringBuilder 512
        [void][LimWin2]::GetWindowText($h, $tt, 512)
        $title = $tt.ToString()
        if (-not $title) { return $true }
        if ($title -match '(?i)ghost') { return $true }   # our own overlay
        if ($title -match '(?i)discord|limey') {
            $r = New-Object LimWin2+R
            [void][LimWin2]::GetWindowRect($h, [ref]$r)
            if ($r.L -gt -30000) { $found.Add("$($r.L),$($r.T),$($r.Rt),$($r.B)") }
        }
    } catch { }
    return $true
}
[void][LimWin2]::EnumWindows($cb, [IntPtr]::Zero)
$found
`;

function findDiscordWindow() {
    if (process.platform !== "win32") return Promise.resolve(null);
    return new Promise(resolve => {
        let out = "";
        let child;
        try {
            child = spawn("powershell.exe", [
                "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
                POWERSHELL_WINDOW_LOOKUP,
            ], { windowsHide: true });
        } catch {
            return resolve(null);
        }
        child.stdout.on("data", d => { out += d; });
        child.on("error", () => resolve(null));
        child.on("close", () => {
            let best = null;
            for (const line of out.split(/\r?\n/)) {
                const m = line.trim().match(/^(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/);
                if (!m) continue;
                const rect = {
                    left: +m[1], top: +m[2], right: +m[3], bottom: +m[4],
                    area: (+m[3] - +m[1]) * (+m[4] - +m[2]),
                };
                if (rect.area > (best ? best.area : 0)) best = rect;
            }
            resolve(best);
        });
    });
}

/** The physical-px rect lives on exactly one display; Electron takes DIPs. */
function displayForPhysicalRect(rect) {
    const displays = screen.getAllDisplays();
    for (const d of displays) {
        const s = d.scaleFactor || 1;
        const phys = {
            x: Math.round(d.bounds.x * s),
            y: Math.round(d.bounds.y * s),
            width: Math.round(d.bounds.width * s),
            height: Math.round(d.bounds.height * s),
        };
        if (rect.left >= phys.x && rect.top >= phys.y &&
            rect.right <= phys.x + phys.width && rect.bottom <= phys.y + phys.height) {
            return d;
        }
    }
    return screen.getPrimaryDisplay();
}

function sendEspStatusToGui(status) {
    if (win && !win.isDestroyed()) win.webContents.send("esp-status", status);
}

function sendEspState() {
    if (!espWin || espWin.isDestroyed()) return;

    // Web version (Discord in a browser tab): the OS window contains browser
    // chrome (tab bar, URL bar) above the Discord viewport, so anchor coords
    // need the viewport's offset inside the full window. The plugin relays its
    // viewport size; we know the OS window's physical size, so the difference,
    // expressed in the same CSS px the canvas uses, is the offset. The
    // desktop version is frameless with an in-page title bar, so this is ~0.
    let offsets = { x: 0, y: 0 };
    const vp = lastGhostState && lastGhostState.viewport;
    if (lastDiscordRect && vp && vp.dpr > 0 && vp.vw > 0 && vp.vh > 0) {
        const cssW = (lastDiscordRect.right - lastDiscordRect.left) / vp.dpr;
        const cssH = (lastDiscordRect.bottom - lastDiscordRect.top) / vp.dpr;
        offsets = {
            x: Math.max(0, Math.round(((cssW - vp.vw) / 2) * 10) / 10),
            y: Math.max(0, Math.round((cssH - vp.vh) * 10) / 10),
        };
    }
    espWin.webContents.send("esp-state", { ...lastGhostState, offsets });
}

/** Find Discord, snap the ESP canvas onto it (DIP bounds + zoom factor). */
let lastDiscordRect = null;

async function ensureEsp() {
    const rect = await findDiscordWindow();
    if (!rect) {
        stopEsp();
        sendEspStatusToGui({ on: false, reason: "Discord window not found" });
        return false;
    }

    if (!espWin || espWin.isDestroyed()) {
        espWin = new BrowserWindow({
            x: rect.left,
            y: rect.top,
            width: Math.max(1, rect.right - rect.left),
            height: Math.max(1, rect.bottom - rect.top),
            frame: false,
            transparent: true,
            hasShadow: false,
            resizable: false,
            skipTaskbar: true,
            focusable: false,
            alwaysOnTop: true,
            backgroundColor: "#00000000",
            show: false,
            webPreferences: {
                contextIsolation: false,
                nodeIntegration: true,
                backgroundThrottling: false
            }
        });
        espWin.setAlwaysOnTop(true, "screen-saver");
        // The canvas is display-only: every click, scroll and key goes to Discord.
        espWin.setIgnoreMouseEvents(true);
        espWin.loadFile(join(__dirname, "renderer", "esp.html"));
        espWin.webContents.once("did-finish-load", () => {
            if (espWin && !espWin.isDestroyed()) {
                espWin.showInactive();
                sendEspState();
            }
        });
        espWin.on("closed", () => { espWin = null; });
    }

    const d = displayForPhysicalRect(rect);
    const scale = d.scaleFactor || 1;
    espWin.setBounds({
        x: Math.round(rect.left / scale),
        y: Math.round(rect.top / scale),
        width: Math.max(1, Math.round((rect.right - rect.left) / scale)),
        height: Math.max(1, Math.round((rect.bottom - rect.top) / scale)),
    });

    // Match the Discord renderer's page zoom: its devicePixelRatio equals
    // screen scale x page zoom, so mirroring it lets our CSS px line up 1:1
    // with the anchor coordinates the plugin measured in its own viewport.
    lastDiscordRect = rect;
    const dpr = (lastGhostState && lastGhostState.viewport && lastGhostState.viewport.dpr) || scale;
    espWin.webContents.setZoomFactor(dpr / scale);

    return true;
}

function stopEsp() {
    espEnabled = false;
    if (espAlignTimer) {
        clearInterval(espAlignTimer);
        espAlignTimer = null;
    }
    if (espWin && !espWin.isDestroyed()) espWin.destroy();
    espWin = null;
}

async function toggleEsp() {
    if (espEnabled) {
        stopEsp();
        sendEspStatusToGui({ on: false });
        return false;
    }
    if (process.platform !== "win32") {
        sendEspStatusToGui({ on: false, reason: "ESP mode is Windows-only (it snaps onto the Discord window)" });
        return false;
    }
    espEnabled = true;
    const ok = await ensureEsp();
    if (!ok) return false;

    // Re-snap periodically in case Discord is moved, resized or restarted.
    espAlignTimer = setInterval(async () => {
        if (!espEnabled) return;
        await ensureEsp();
    }, 4000);
    sendEspStatusToGui({ on: true });
    return true;
}

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
    globalShortcut.register("Shift+F11", () => void toggleEsp());

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

// ESP mode: the GUI toggles the canvas (button or Shift+F11); the GUI renderer
// also forwards every relay state snapshot here so the canvas can redraw live.
ipcMain.handle("esp-toggle", () => toggleEsp());
ipcMain.on("ghost-state", (_event, state) => {
    lastGhostState = state;
    sendEspState();
});

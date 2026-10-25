/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

if (process.platform === "linux") import("./venmic");

import { execFile } from "child_process";
import {
    app,
    BrowserWindow,
    clipboard,
    ClipboardItem,
    dialog,
    IpcMainInvokeEvent,
    RelaunchOptions,
    session,
    shell
} from "electron";
import { existsSync, readFileSync, watch } from "fs";
import { readFile, stat } from "fs/promises";
import { release } from "os";
import { join } from "path";

import { IpcEvents } from "../shared/IpcEvents";
import { setBadgeCount } from "./appBadge";
import { autoStart } from "./autoStart";
import { enableHardwareAcceleration } from "./main";
import { mainWin } from "./mainWindow";
import { Settings, State } from "./settings";
import { handle, handleSync } from "./utils/ipcWrappers";
import { PopoutWindows } from "./utils/popout";
import { isDeckGameMode, showGamePage } from "./utils/steamOS";
import { isValidLimeyV1Install } from "./utils/limeyLoader";
import { LIMEY_FILES_DIR } from "./limeyFilesDir";

handleSync(IpcEvents.GET_LIMEY_PRELOAD_SCRIPT, () =>
    readFileSync(join(LIMEY_FILES_DIR, "limeyV1DesktopPreload.js"), "utf-8")
);
handleSync(IpcEvents.GET_LIMEY_RENDERER_SCRIPT, () =>
    readFileSync(join(LIMEY_FILES_DIR, "limeyV1DesktopRenderer.js"), "utf-8")
);

const LIMEY_RENDERER_JS_PATH = join(__dirname, "renderer.js");
const LIMEY_RENDERER_CSS_PATH = join(__dirname, "renderer.css");
handleSync(IpcEvents.GET_LIMEY_DESKTOP_RENDERER_SCRIPT, () => readFileSync(LIMEY_RENDERER_JS_PATH, "utf-8"));
handle(IpcEvents.GET_LIMEY_RENDERER_CSS, () => readFile(LIMEY_RENDERER_CSS_PATH, "utf-8"));

if (IS_DEV) {
    watch(LIMEY_RENDERER_CSS_PATH, { persistent: false }, async () => {
        mainWin?.webContents.postMessage(
            IpcEvents.LIMEY_RENDERER_CSS_UPDATE,
            await readFile(LIMEY_RENDERER_CSS_PATH, "utf-8")
        );
    });
}

handleSync(IpcEvents.GET_SETTINGS, () => Settings.plain);
handleSync(IpcEvents.GET_VERSION, () => app.getVersion());
handleSync(IpcEvents.GET_ENABLE_HARDWARE_ACCELERATION, () => enableHardwareAcceleration);

handleSync(
    IpcEvents.SUPPORTS_WINDOWS_TRANSPARENCY,
    () => process.platform === "win32" && Number(release().split(".").pop()) >= 22621
);

handleSync(IpcEvents.AUTOSTART_ENABLED, () => autoStart.isEnabled());
handle(IpcEvents.ENABLE_AUTOSTART, autoStart.enable);
handle(IpcEvents.DISABLE_AUTOSTART, autoStart.disable);

handle(IpcEvents.SET_SETTINGS, (_, settings: typeof Settings.store, path?: string) => {
    Settings.setData(settings, path);
});

handle(IpcEvents.RELAUNCH, async () => {
    const options: RelaunchOptions = {
        args: process.argv.slice(1).concat(["--relaunch"])
    };
    if (isDeckGameMode) {
        // We can't properly relaunch when running under gamescope, but we can at least navigate to our page in Steam.
        await showGamePage();
    } else if (app.isPackaged && process.env.APPIMAGE) {
        execFile(process.env.APPIMAGE, options.args);
    } else {
        app.relaunch(options);
    }
    app.exit();
});

handleSync(IpcEvents.IS_USING_CUSTOM_LIMEY_DIR, () => !!State.store.limeyDir);
handle(IpcEvents.SHOW_CUSTOM_LIMEY_DIR, async () => {
    const { limeyDir } = State.store;
    if (!limeyDir) return;

    const stats = await stat(limeyDir);
    if (!stats.isDirectory()) return;

    shell.openPath(limeyDir);
});

// Used by the Limey V1 mod's showItemInFolder (file drops, theme links etc.)
handle(IpcEvents.SHOW_ITEM_IN_FOLDER, (e, itemPath: string) => {
    if (typeof itemPath !== "string" || !existsSync(itemPath)) return;

    shell.showItemInFolder(itemPath);
});

function getWindow(e: IpcMainInvokeEvent, key?: string) {
    return key ? PopoutWindows.get(key)! : (BrowserWindow.fromWebContents(e.sender) ?? mainWin);
}

handle(IpcEvents.FOCUS, () => {
    mainWin.show();
    mainWin.setSkipTaskbar(false);
});

handle(IpcEvents.CLOSE, (e, key?: string) => {
    getWindow(e, key).close();
});

handle(IpcEvents.MINIMIZE, (e, key?: string) => {
    getWindow(e, key).minimize();
});

handle(IpcEvents.MAXIMIZE, (e, key?: string) => {
    const win = getWindow(e, key);
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
});

handleSync(IpcEvents.SPELLCHECK_GET_AVAILABLE_LANGUAGES, e => {
    e.returnValue = session.defaultSession.availableSpellCheckerLanguages;
});

handle(IpcEvents.SPELLCHECK_REPLACE_MISSPELLING, (e, word: string) => {
    e.sender.replaceMisspelling(word);
});

handle(IpcEvents.SPELLCHECK_ADD_TO_DICTIONARY, (e, word: string) => {
    e.sender.session.addWordToSpellCheckerDictionary(word);
});

handle(IpcEvents.SELECT_LIMEY_DIR, async (_e, value?: null) => {
    if (value === null) {
        delete State.store.limeyDir;
        return "ok";
    }

    const res = await dialog.showOpenDialog(mainWin!, {
        properties: ["openDirectory"]
    });
    if (!res.filePaths.length) return "cancelled";

    const dir = res.filePaths[0];
    if (!(await isValidLimeyV1Install(dir))) return "invalid";

    State.store.limeyDir = dir;

    return "ok";
});

handle(IpcEvents.SET_BADGE_COUNT, (_, count: number) => setBadgeCount(count));

handle(IpcEvents.FLASH_FRAME, (_, flag: boolean) => {
    if (!mainWin || mainWin.isDestroyed() || (flag && mainWin.isFocused())) return;
    mainWin.flashFrame(flag);
});

handle(IpcEvents.CLIPBOARD_COPY_IMAGE, async (_, buf: ArrayBuffer, src: string) => {
    src = src.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

    clipboard.write([
        new ClipboardItem({
            "text/html": `<img src="${src}" />`,
            "image/png": new Blob([buf], { type: "image/png" })
        })
    ]);
});

function openDebugPage(page: string) {
    const win = new BrowserWindow({
        autoHideMenuBar: true
    });

    win.loadURL(page);
}

handle(IpcEvents.DEBUG_LAUNCH_GPU, () => openDebugPage("chrome://gpu"));
handle(IpcEvents.DEBUG_LAUNCH_WEBRTC_INTERNALS, () => openDebugPage("chrome://webrtc-internals"));

/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";
import { LimeyV1DesktopNative } from "./LimeyV1DesktopNative";

// Must not collide with the client mod's own preload global (LimeyV1Native,
// bound by limeyV1DesktopPreload.js below) — the mod preload runs after these
// bindings inside the same sandbox and ContextBridge throws "Cannot bind an
// API on top of an existing property" on collisions, which used to kill the
// whole preload and silently disable Limey V1.
//
// VesktopNative is the name the Limey V1 mod and upstream plugins expect
// (src/utils/native.ts, IS_VESKTOP plugin code); LimeyV1DesktopNative is the
// rebranded name the desktop shell's own renderer uses. Same object, both
// names — neither collides with LimeyV1Native.
contextBridge.exposeInMainWorld("VesktopNative", LimeyV1DesktopNative);
contextBridge.exposeInMainWorld("LimeyV1DesktopNative", LimeyV1DesktopNative);

// While sandboxed, Electron "polyfills" these APIs as local variables.
// We have to pass them as arguments as they are not global.
// This must not throw past this point: a failing mod preload (e.g. a stale
// copy that binds a global we already bound) previously aborted the rest of
// this script and silently disabled Limey V1 entirely.
try {
    Function(
        "require",
        "Buffer",
        "process",
        "clearImmediate",
        "setImmediate",
        ipcRenderer.sendSync(IpcEvents.GET_LIMEY_PRELOAD_SCRIPT)
    )(require, Buffer, process, clearImmediate, setImmediate);
} catch (err) {
    console.error("[Limey V1 Desktop] Failed to run the Limey V1 mod preload script", err);
}
// Still inject the renderer scripts so the desktop shell (settings, fixes,
// arRPC) keeps working even when the mod preload above misbehaves.
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_LIMEY_RENDERER_SCRIPT));
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_LIMEY_DESKTOP_RENDERER_SCRIPT));

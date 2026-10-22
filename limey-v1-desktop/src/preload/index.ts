/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { contextBridge, ipcRenderer, webFrame } from "electron/renderer";

import { IpcEvents } from "../shared/IpcEvents";
import { LimeyV1Native } from "./LimeyV1Native";

contextBridge.exposeInMainWorld("LimeyV1Native", LimeyV1Native);

// While sandboxed, Electron "polyfills" these APIs as local variables.
// We have to pass them as arguments as they are not global
Function(
    "require",
    "Buffer",
    "process",
    "clearImmediate",
    "setImmediate",
    ipcRenderer.sendSync(IpcEvents.GET_LIMEY_PRELOAD_SCRIPT)
)(require, Buffer, process, clearImmediate, setImmediate);

webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_LIMEY_RENDERER_SCRIPT));
webFrame.executeJavaScript(ipcRenderer.sendSync(IpcEvents.GET_LIMEY_DESKTOP_RENDERER_SCRIPT));

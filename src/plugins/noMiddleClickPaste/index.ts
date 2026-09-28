/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2024 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs, IS_LINUX } from "@utils/constants";
import definePlugin from "@utils/types";

function preventMiddleClick(e: MouseEvent) {
    if (e.button === 1) {
        e.preventDefault();
    }
}

export default definePlugin({
    name: "NoMiddleClickPaste",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Disable Linux middle-click paste - Linux only",
    authors: [Devs.Darxoon],
    hidden: !IS_LINUX,

    start() {
        window.addEventListener("mouseup", preventMiddleClick);
    },

    stop() {
        window.removeEventListener("mouseup", preventMiddleClick);
    },
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export let EXTENSION_VERSION: string;
export let EXTENSION_BASE_URL: string;
export let RENDERER_CSS_URL: string;

let resolveMetaReady: Function;
export const metaReady = new Promise<void>(res => resolveMetaReady = res);

// The meta handshake is used by the browser-extension shell (browser/content.js):
// it would be dead code in the userscript build (which embeds its CSS in
// _vcUserScriptRendererCss). Note builds never set IS_EXTENSION=true (the web
// build compiles IS_WEB); gate on the build kinds that actually consume it.
if (IS_WEB && !IS_USERSCRIPT) {
    const listener = (e: MessageEvent) => {
        if (e.data?.type === "limeyV1:meta") {
            ({ EXTENSION_BASE_URL, EXTENSION_VERSION, RENDERER_CSS_URL } = e.data.meta);
            window.removeEventListener("message", listener);
            resolveMetaReady();
        }
    };

    window.addEventListener("message", listener);
}

/*
 * Limey V1 — package the browser extension into dist/LimeyV1-Extension.zip
 * Uses fflate (already a runtime dependency), no other tools required.
 * Run after `pnpm buildWeb`.
 *
 * Layout note: the zip must be directly loadable — "unzip, then Load unpacked
 * the folder". So manifest.json and the shell files sit at the zip root and
 * the built bundle stays under dist/ where both manifests reference it.
 */

import { createWriteStream } from "fs";
import { readFile } from "fs/promises";
import { zipSync } from "fflate";

// [zip entry, source path] — the extension root must contain manifest.json.
const files = [
    // Extension manifests (MV3 Chrome/Edge + MV2 Firefox)
    ["manifest.json", "browser/manifest.json"],
    ["manifestv2.json", "browser/manifestv2.json"],
    // Extension shell (service worker, content script, etc.)
    ["background.js", "browser/background.js"],
    ["content.js", "browser/content.js"],
    ["service-worker.js", "browser/service-worker.js"],
    ["GMPolyfill.js", "browser/GMPolyfill.js"],
    // Toolbar popup GUI (browser action)
    ["popup.html", "browser/popup.html"],
    ["popup.js", "browser/popup.js"],
    ["patch-worker.js", "browser/patch-worker.js"],
    ["modifyResponseHeaders.json", "browser/modifyResponseHeaders.json"],
    ["icon.png", "browser/icon.png"],
    // Built mod bundle — dist/browser.js, matching the manifests' content script
    ["dist/browser.js", "dist/browser.js"],
    ["dist/browser.css", "dist/browser.css"],
];

const zipData = {};
for (const [entry, path] of files) {
    try {
        zipData[entry] = new Uint8Array(await readFile(path));
    } catch (err) {
        console.warn(`[zipExtension] skipping missing file ${path}: ${err.message}`);
    }
}

if (!zipData["dist/browser.js"]) {
    console.error("[zipExtension] dist/browser.js missing — run `pnpm buildWeb` first");
    process.exit(1);
}
if (!zipData["manifest.json"]) {
    console.error("[zipExtension] browser/manifest.json missing — cannot package the extension");
    process.exit(1);
}

const zipped = zipSync(zipData, { level: 9 });
const out = createWriteStream("dist/LimeyV1-Extension.zip");
out.write(zipped);
out.end(() => {
    console.log(`[zipExtension] wrote dist/LimeyV1-Extension.zip (${(zipped.length / 1024).toFixed(1)} KB, ${Object.keys(zipData).length} files)`);
});

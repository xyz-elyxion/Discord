/*
 * Limey V1 — package the browser extension into dist/LimeyV1-Extension.zip
 * Uses fflate (already a runtime dependency), no other tools required.
 * Run after `pnpm buildWeb`.
 */

import { createWriteStream } from "fs";
import { readFile, stat } from "fs/promises";
import { join } from "path";
import { zipSync } from "fflate";

const files = [
    // Extension shell (manifests, service worker, content script, etc.)
    "browser/manifest.json",
    "browser/manifestv2.json",
    "browser/background.js",
    "browser/content.js",
    "browser/service-worker.js",
    "browser/GMPolyfill.js",
    "browser/patch-worker.js",
    "browser/modifyResponseHeaders.json",
    "browser/icon.png",
    // Built mod bundle
    "dist/browser.js",
    "dist/browser.css",
];

// Optional monaco vendor bundle (QuickCSS editor)
try {
    const vendorDir = "dist/vendor/monaco";
    for (const f of ["index.js"]) {
        await stat(join(vendorDir, f));
        files.push(`${vendorDir}/${f}`);
    }
} catch { /* monaco not built — skip */ }

const zipData = {};
for (const file of files) {
    try {
        zipData[file] = new Uint8Array(await readFile(file));
    } catch (err) {
        console.warn(`[zipExtension] skipping missing file ${file}: ${err.message}`);
    }
}

if (!zipData["dist/browser.js"]) {
    console.error("[zipExtension] dist/browser.js missing — run `pnpm buildWeb` first");
    process.exit(1);
}

const zipped = zipSync(zipData, { level: 9 });
const out = createWriteStream("dist/LimeyV1-Extension.zip");
out.write(zipped);
out.end(() => {
    console.log(`[zipExtension] wrote dist/LimeyV1-Extension.zip (${(zipped.length / 1024).toFixed(1)} KB, ${Object.keys(zipData).length} files)`);
});

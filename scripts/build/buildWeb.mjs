#!/usr/bin/node
/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// @ts-check

import { readFileSync } from "fs";
import { appendFile, readFile } from "fs/promises";

import { BUILD_TIMESTAMP, commonOpts, globPlugins, IS_DEV, IS_REPORTER, IS_ANTI_CRASH_TEST, IS_STANDALONE, VERSION, commonRendererPlugins, buildOrWatchAll, stringifyValues } from "./common.mjs";

/**
 * @type {import("esbuild").BuildOptions}
 */
const commonOptions = {
    ...commonOpts,
    entryPoints: ["browser/LimeyV1.ts"],
    format: "iife",
    globalName: "LimeyV1",
    external: ["~plugins", "~git-hash", "/assets/*"],
    target: ["esnext"],
    plugins: [
        globPlugins("web"),
        ...commonRendererPlugins
    ],
    define: stringifyValues({
        IS_WEB: true,
        IS_EXTENSION: false,
        IS_USERSCRIPT: false,
        IS_STANDALONE,
        IS_DEV,
        IS_REPORTER,
        IS_ANTI_CRASH_TEST,
        IS_DISCORD_DESKTOP: false,
        IS_VESKTOP: false,
        IS_UPDATER_DISABLED: true,
        VERSION,
        BUILD_TIMESTAMP
    })
};

const MonacoWorkerEntryPoints = [
    "vs/language/css/css.worker.js",
    "vs/editor/editor.worker.js"
];

/** @type {import("esbuild").BuildOptions[]} */
const buildConfigs = [
    {
        entryPoints: MonacoWorkerEntryPoints.map(entry => `node_modules/monaco-editor/esm/${entry}`),
        bundle: true,
        minify: true,
        format: "iife",
        outbase: "node_modules/monaco-editor/esm/",
        outdir: "dist/vendor/monaco"
    },
    {
        entryPoints: ["browser/monaco.ts"],
        bundle: true,
        minify: true,
        format: "iife",
        outfile: "dist/vendor/monaco/index.js",
        loader: {
            ".ttf": "file"
        }
    },
    {
        ...commonOptions,
        outfile: "dist/browser.js",
        footer: { js: "//# sourceURL=file:///LimeyV1Web" }
    },
    {
        ...commonOptions,
        inject: ["browser/GMPolyfill.js", ...(commonOptions?.inject || [])],
        define: {
            ...commonOptions.define,
            IS_USERSCRIPT: "true",
            window: "unsafeWindow",
        },
        outfile: "dist/LimeyV1.user.js",
        banner: {
            js: readFileSync("browser/userscript.meta.js", "utf-8").replace("%version%", `${VERSION}.${new Date().getTime()}`)
        },
        footer: {
            // UserScripts get wrapped in an iife, so define LimeyV1 prop on window that returns our local
            js: "Object.defineProperty(unsafeWindow,'LimeyV1',{get:()=>LimeyV1});"
        }
    }
];

await buildOrWatchAll(buildConfigs);

// --- Obfuscation (production only) ---
// Mangles identifiers, control-flow flattens and dead-code injects the shipped
// userscript/extension bundle to discourage casual tampering/rebranding.
// Dev/watch builds and the reporter stay readable. Set LIMEY_NO_OBFUSCATE=1 to skip.
if (!IS_DEV && !IS_REPORTER && process.env.LIMEY_NO_OBFUSCATE !== "1") {
    const { readFileSync, writeFileSync } = await import("fs");
    const JavaScriptObfuscator = (await import("javascript-obfuscator")).default;

    // Conservative options: mangle identifiers and fold strings without
    // selfDefending/base64 encoding — aggressive modes (selfDefending,
    // deadCodeInjection, stringArrayEncoding) break inside userscript managers.
    const obfuscateOptions = {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        stringArray: true,
        stringArrayEncoding: [],
        stringArrayThreshold: 0.5,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        identifierNamesGenerator: "hexadecimal",
        renameGlobals: false, // keep the LimeyV1 global intact
        selfDefending: false,
        sourceMap: false
    };

    for (const file of ["dist/browser.js", "dist/LimeyV1.user.js"]) {
        const before = readFileSync(file, "utf-8");
        const result = JavaScriptObfuscator.obfuscate(before, obfuscateOptions);
        writeFileSync(file, result.getObfuscatedCode());
        console.log(`[obfuscate] ${file} (${(before.length / 1e6).toFixed(1)}MB -> ${(result.getObfuscatedCode().length / 1e6).toFixed(1)}MB)`);
    }
}

const appendCssRuntime = readFile("dist/LimeyV1.user.css", "utf-8").then(content => {
    const cssRuntime = `unsafeWindow._vcUserScriptRendererCss=\`${content.replaceAll("`", "\\`")}\``;

    return appendFile("dist/LimeyV1.user.js", cssRuntime);
});

await appendCssRuntime;

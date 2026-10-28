/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
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

/**
 * Bundles Monaco (the editor core behind VS Code) into dist/vendor/monaco so
 * the web server can serve it at /vendor/monaco/*.
 *
 * Outputs:
 *   index.js          IIFE bundle that sets window.monaco and MonacoEnvironment
 *   index.css         every editor style, extracted from the imported modules
 *   editor.worker.js  core editor worker
 *   ts.worker.js      TypeScript/JavaScript language service (IntelliSense)
 *   json/css/html.worker.js  the other language services
 *   assets/*          codicon font + any other assets the styles reference
 *
 * Used by /code, which tries to load
 * exactly these two files and silently falls back to a textarea without them.
 */

import { mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import * as esbuild from "esbuild";

const OUT_DIR = join("dist", "vendor", "monaco");

const WORKERS = {
    "editor.worker": "monaco-editor/editor/editor.worker.js",
    "ts.worker": "monaco-editor/language/typescript/ts.worker.js",
    "json.worker": "monaco-editor/language/json/json.worker.js",
    "css.worker": "monaco-editor/language/css/css.worker.js",
    "html.worker": "monaco-editor/language/html/html.worker.js"
};

const COMMON = {
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome110", "firefox110", "safari16"],
    minify: true,
    legalComments: "none",
    logLevel: "warning",
    define: { "process.env.NODE_ENV": "\"production\"" }
};

// The entry assigns the global because the page loads this with a plain
// <script> tag, exactly like the workspace bundle it already ships.
const ENTRY = `
import * as monaco from "monaco-editor";

// Monaco asks for a worker by language label; each bundle below is built as
// its own classic worker script.
self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
        switch (label) {
            case "json": return new Worker("/vendor/monaco/json.worker.js");
            case "css":
            case "scss":
            case "less": return new Worker("/vendor/monaco/css.worker.js");
            case "html":
            case "handlebars":
            case "razor": return new Worker("/vendor/monaco/html.worker.js");
            case "typescript":
            case "javascript": return new Worker("/vendor/monaco/ts.worker.js");
            default: return new Worker("/vendor/monaco/editor.worker.js");
        }
    }
};

window.monaco = monaco;
`;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const started = Date.now();

await esbuild.build({
    ...COMMON,
    stdin: {
        contents: ENTRY,
        resolveDir: process.cwd(),
        sourcefile: "monaco-entry.js",
        loader: "js"
    },
    outfile: join(OUT_DIR, "index.js"),
    assetNames: "assets/[name]-[hash]",
    // The editor ships a codicon font; without a loader esbuild refuses the CSS.
    loader: { ".ttf": "file", ".woff": "file", ".woff2": "file", ".svg": "file", ".png": "file" }
});

for (const [name, entry] of Object.entries(WORKERS)) {
    await esbuild.build({
        ...COMMON,
        entryPoints: [entry],
        outfile: join(OUT_DIR, `${name}.js`)
    });
}

const files = ["index.js", "index.css", ...Object.keys(WORKERS).map(name => `${name}.js`)];
for (const file of files) {
    try {
        const kb = (statSync(join(OUT_DIR, file)).size / 1024).toFixed(0);
        console.log(`[buildMonaco] ${file.padEnd(20)} ${kb} KB`);
    } catch {
        console.warn(`[buildMonaco] missing output ${file}`);
    }
}

console.log(`[buildMonaco] wrote ${OUT_DIR} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

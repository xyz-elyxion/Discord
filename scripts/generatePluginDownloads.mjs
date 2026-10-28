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
 * Builds the download artifacts for the plugin marketplace (/marketplace).
 *
 * Reads the generated plugin catalog (web/public/plugins.json), zips each
 * built-in plugin's source folder into web/public/plugin-downloads/<slug>.zip
 * and writes an index.json the marketplace page fetches to show the download
 * buttons. The archives are build output: run `pnpm generatePluginDownloads`
 * after `pnpm generatePluginJson web/public/plugins.json web/public/readmes.json`.
 *
 * Core plugins (filePath starting with "_") are skipped — they are mod
 * internals, not something anyone installs as a userplugin.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join, relative, sep } from "path";
import { zipSync } from "fflate";

const PUBLIC_DIR = join("web", "public");
const CATALOG = join(PUBLIC_DIR, "plugins.json");
const OUT_DIR = join(PUBLIC_DIR, "plugin-downloads");

if (!existsSync(CATALOG)) {
    console.error(`Missing ${CATALOG} — run "pnpm generatePluginJson web/public/plugins.json web/public/readmes.json" first.`);
    process.exit(1);
}

/** Every file under a plugin folder, as archive paths relative to it. */
function walk(dir, root = dir) {
    const out = [];

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, root));
        else if (entry.isFile()) out.push(relative(root, full).split(sep).join("/"));
    }

    return out;
}

/**
 * A plugin is either a folder with an index (filePath is the folder) or a
 * single file (filePath has no extension, e.g. "_core/settings") — so resolve
 * against the filesystem instead of assuming either shape.
 */
function resolveSource(filePath) {
    const full = join("src", "plugins", filePath);
    if (existsSync(full)) {
        return statSync(full).isDirectory() ? { dir: full, single: null } : { dir: null, single: full };
    }

    // Catalog entries for single-file plugins normally keep the extension, but
    // accept a bare path too rather than silently dropping the plugin.
    for (const ext of [".tsx", ".ts"]) {
        if (existsSync(full + ext)) return { dir: null, single: full + ext };
    }

    return null;
}

function slug(filePath) {
    return filePath.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

const plugins = JSON.parse(readFileSync(CATALOG, "utf8"));
const index = {};
let written = 0;
let bytes = 0;

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

for (const plugin of plugins) {
    if (!plugin.name || !plugin.filePath || plugin.filePath.startsWith("_")) continue;

    const source = resolveSource(plugin.filePath);
    if (!source) {
        console.warn(`[plugin-downloads] skipped ${plugin.name}: no source for ${plugin.filePath}`);
        continue;
    }

    // Everything lands inside one top-level folder so the archive can be
    // unzipped straight into src/userplugins.
    const folder = basename(plugin.filePath).replace(/\.tsx?$/, "");
    const entries = {};

    if (source.dir) {
        for (const rel of walk(source.dir)) {
            entries[`${folder}/${rel}`] = new Uint8Array(readFileSync(join(source.dir, rel)));
        }
    } else {
        entries[`${folder}/${basename(source.single)}`] = new Uint8Array(readFileSync(source.single));
    }

    const fileCount = Object.keys(entries).length;
    if (!fileCount) continue;

    const zip = zipSync(entries, { level: 9 });
    const fileName = `${slug(plugin.filePath)}.zip`;
    writeFileSync(join(OUT_DIR, fileName), zip);

    index[plugin.name] = { file: fileName, bytes: zip.length, files: fileCount };
    written += 1;
    bytes += zip.length;
}

writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify({
    schema: 1,
    generatedAt: new Date().toISOString(),
    plugins: index
}, null, 4) + "\n");

const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`[plugin-downloads] wrote ${written} plugin archives to ${OUT_DIR} (${mb} MB)`);

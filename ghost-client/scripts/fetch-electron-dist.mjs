/*
 * Downloads the Electron win32-x64 dist into electron-builder's cache so the
 * bundler (Go app-builder) never pulls from GitHub release assets itself —
 * some CI hosts (Render's builders) block or rate-limit those downloads and
 * the whole image build dies mid-stage.
 *
 * Uses the npmmirror CDN mirror with retries. Resolves the Electron version
 * from node_modules/electron/package.json (pass an explicit version as the
 * first argument to override).
 *
 * Writes the zip to every cache location electron-builder may look in:
 *   - $XDG_CACHE_HOME/electron           (Docker stage sets this)
 *   - $HOME/.cache/electron              (standard Linux default)
 */
import { createWriteStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";

const version = process.argv[2]
    ?? JSON.parse(readFileSync(join(process.cwd(), "node_modules", "electron", "package.json"), "utf8")).version;
if (!/^v?\d+\.\d+\.\d+$/.test(version)) {
    console.error(`invalid electron version resolved: ${version}`);
    process.exit(1);
}
const v = version.replace(/^v/, "");

const url = `https://npmmirror.com/mirrors/electron/v${v}/electron-v${v}-win32-x64.zip`;
const file = `electron-v${v}-win32-x64.zip`;

const home = homedir();
const cacheDirs = [
    process.env.XDG_CACHE_HOME ? join(process.env.XDG_CACHE_HOME, "electron") : null,
    home ? join(home, ".cache", "electron") : null,
].filter(Boolean);
if (!cacheDirs.length) {
    console.error("[fetch-electron-dist] no cache dir could be resolved (set XDG_CACHE_HOME or HOME)");
    process.exit(1);
}

let ok = false;
for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!res.body) throw new Error("empty response body");

        await mkdir(cacheDirs[0], { recursive: true });
        const target = join(cacheDirs[0], file);
        await pipeline(res.body, createWriteStream(target));
        ok = true;

        // Mirror the file into the other cache locations the bundler may use.
        for (const dir of cacheDirs.slice(1)) {
            await mkdir(dir, { recursive: true });
            await copyFile(target, join(dir, file));
        }
        console.log(`[fetch-electron-dist] v${v} cached: ${target}`);
    } catch (err) {
        if (attempt >= 5) throw err;
        console.error(`[fetch-electron-dist] attempt ${attempt} failed (${err.message}) — retrying in 3s`);
        await new Promise(r => setTimeout(r, 3000));
    }
}

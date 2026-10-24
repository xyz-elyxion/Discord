#!/usr/bin/env node
"use strict";

/*
 * Limebot single-file launcher — for hosts that can only run ONE file and
 * have no interactive console (e.g. WispByte). Point the "startup file" at
 * this script:
 *
 *     node run.js
 *
 * On first boot it:
 *   1. installs dependencies with plain npm (no pnpm needed, no lifecycle
 *      scripts so nothing depends on build tools being present),
 *   2. builds dist/ with esbuild (the only build dependency),
 *   3. restores the native binding for better-sqlite3 (its prebuild download
 *      needs an install script; sharp and @napi-rs/canvas ship prebuilt
 *      packages via optionalDependencies),
 *   4. starts the bot-only entry (dist/botOnly.js) — gateway + commands,
 *      no HTTP server.
 *
 * Subsequent boots are instant (markers are present: no install, no build).
 * Set LIMEBOT_BOOTSTRAP_DRYRUN=1 to only prepare and exit — handy to check a
 * panel's first-boot logs without actually connecting to Discord.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const has = p => fs.existsSync(path.join(root, p));

function run(cmd, args) {
    const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
    if (res.status !== 0) {
        console.error(`[limebot] \`${cmd} ${args.join(" ")}\` failed (exit ${res.status ?? res.error}); startup aborted`);
        process.exit(res.status ?? 1);
    }
}

// 1. dependencies (marker: esbuild is required by the build step below)
if (!has("node_modules/esbuild/package.json")) {
    console.log("[limebot] first boot — installing dependencies with npm (--ignore-scripts)...");
    run(npmCmd, ["install", "--ignore-scripts", "--no-audit", "--no-fund"]);
}

// 2. bundle
if (!has("dist/botOnly.js")) {
    console.log("[limebot] building dist/ bundles with esbuild...");
    run(process.execPath, ["scripts/build.mjs"]);
}

// 3. native binding for better-sqlite3 (idempotent, instant when already built)
run(npmCmd, ["rebuild", "better-sqlite3"]);

if (process.env.LIMEBOT_BOOTSTRAP_DRYRUN === "1") {
    console.log("[limebot] bootstrap dry run OK — dependencies installed, dist present, SQLite binding intact (not starting)");
    return; // top-level return is valid in CommonJS
}

// 4. start the bot (botOnly sets its own mode flags before server code runs)
require("./dist/botOnly.js");

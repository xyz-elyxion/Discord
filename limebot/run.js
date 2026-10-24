#!/usr/bin/env node
"use strict";

/*
 * Limebot single-file launcher — for hosts that can only run ONE file and
 * have no interactive console (e.g. WispByte). Point the "startup file" at
 * this script:
 *
 *     node run.js
 *
 * On boot it:
 *   1. installs dependencies with plain npm when needed (no pnpm required).
 *      npm >= 12 blocks dependency lifecycle scripts unless the project's
 *      allowScripts policy permits them, so the policy in package.json
 *      drives what may run; we deliberately do NOT pass --ignore-scripts
 *      (it would override the policy AND leave sharp's platform binaries
 *      in a broken state on some hosts).
 *   2. bumps INSTALL_VERSION repair semantics: if a previously-installed
 *      node_modules was created by an older bootstrap logic (e.g. blocked
 *      scripts or skipped optional platform packages), the marker mismatch
 *      forces one clean reinstall.
 *   3. builds dist/ with esbuild when missing,
 *   4. verifies the native pieces (better-sqlite3 binding, sharp runtime),
 *   5. starts the bot-only entry (dist/botOnly.js) — gateway + commands,
 *      no HTTP server.
 *
 * Subsequent boots are instant (markers present).
 * Set LIMEBOT_BOOTSTRAP_DRYRUN=1 to only prepare and exit — handy to check a
 * panel's first-boot logs without actually connecting to Discord.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
// Bump when install-time behavior changes so running hosts reinstall once.
const INSTALL_VERSION = "3";

const has = p => fs.existsSync(path.join(root, p));
const markerFile = path.join(root, "node_modules", ".limebot-install-version");

function run(cmd, args) {
    const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
    if (res.status !== 0) {
        console.error(`[limebot] \`${cmd} ${args.join(" ")}\` failed (exit ${res.status ?? res.error}); startup aborted`);
        process.exit(res.status ?? 1);
    }
}

// 1. dependencies
const marker = has("node_modules/esbuild/package.json") ? (() => {
    try { return fs.readFileSync(markerFile, "utf8").trim(); } catch { return null; }
})() : null;
if (marker !== INSTALL_VERSION) {
    if (marker === null) {
        console.log("[limebot] first boot — installing dependencies with npm...");
    } else {
        console.log(`[limebot] repairing stale install (marker ${marker} != ${INSTALL_VERSION}) — reinstalling...`);
    }
    run(npmCmd, ["install", "--no-audit", "--no-fund"]);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    fs.writeFileSync(markerFile, INSTALL_VERSION);
}

// 2. bundle
if (!has("dist/botOnly.js")) {
    console.log("[limebot] building dist/ bundles with esbuild...");
    run(process.execPath, ["scripts/build.mjs"]);
}

// 3. verify native pieces
// 3a. better-sqlite3: npm >= 12's allowScripts policy (package.json) permits
//     its install script; `npm rebuild` is idempotent and instant when ok.
run(npmCmd, ["rebuild", "better-sqlite3"]);
const bindingPaths = [
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/better-sqlite3/build/better_sqlite3.node"
];
if (!has(bindingPaths[0]) && !has(bindingPaths[1])) {
    console.log("[limebot] binding still missing after rebuild — running better-sqlite3's install script directly...");
    run(process.execPath, ["node_modules/better-sqlite3/install.js"]);
    if (!has(bindingPaths[0]) && !has(bindingPaths[1])) {
        console.error("[limebot] better-sqlite3 native binding could not be built (missing build tools on the host?)");
        process.exit(1);
    }
}

// 3b. sharp: loads its per-platform binary from an optional dependency; if
//     the tree is missing it the whole module fails to load.
const sharpCheck = spawnSync(process.execPath, ["-e", "require('sharp')"], { cwd: root, stdio: "pipe" });
if (sharpCheck.status !== 0) {
    console.log("[limebot] sharp failed to load — reinstalling with optional dependencies included...");
    run(npmCmd, ["install", "--include=optional", "--no-audit", "--no-fund"]);
    const retry = spawnSync(process.execPath, ["-e", "require('sharp')"], { cwd: root, stdio: "pipe" });
    if (retry.status !== 0) {
        console.error("[limebot] sharp still failing after reinstall. stderr:");
        console.error((retry.stderr || "").toString().split("\n").slice(-6).join("\n"));
        process.exit(1);
    }
}

if (process.env.LIMEBOT_BOOTSTRAP_DRYRUN === "1") {
    console.log("[limebot] bootstrap dry run OK — dependencies installed, dist present, SQLite binding intact, sharp loads (not starting)");
    return; // top-level return is valid in CommonJS
}

// 4. start the bot (botOnly sets its own mode flags before server code runs)
require("./dist/botOnly.js");

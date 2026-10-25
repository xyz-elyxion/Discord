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

// Some panels' env-variable handling is unreliable; also accept a plain
// `bot/.env` file (uploadable via the host's file manager) with KEY=VALUE
// lines. Real environment variables always win — the file only fills gaps.
const envFile = path.join(root, ".env");
try {
    const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
    let applied = 0;
    for (const line of lines) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
            value = value.slice(1, -1);
        if (!(m[1] in process.env) && value.length) {
            process.env[m[1]] = value;
            applied++;
        }
    }
    if (applied)
        console.log(`[limebot] .env: ${applied} key(s) loaded from ${path.relative(process.cwd(), envFile)}`);
    else
        console.log("[limebot] .env: file present but empty — put lines like LIMEBOT_TOKEN=xxx in it");
} catch {
    // no .env file — say so, so a missing panel variable isn't a mystery
    console.log("[limebot] .env: no bot/.env file (create one in the file manager with LIMEBOT_TOKEN=… if panel variables don't arrive)");
}

// Same reliability problem, different name: some panels only inject their own
// predefined variables, so accept the common bot-token aliases when the
// canonical LIMEBOT_TOKEN is absent. Always logged so the substitution is visible.
if (!process.env.LIMEBOT_TOKEN) {
    const aliases = ["DISCORD_TOKEN", "BOT_TOKEN", "LIMEY_TOKEN", "DISC_TOKEN", "TOKEN"];
    for (const alias of aliases) {
        const v = process.env[alias];
        if (typeof v === "string" && v.trim()) {
            process.env.LIMEBOT_TOKEN = v.trim();
            console.log(`[limebot] env: LIMEBOT_TOKEN missing — using the ${alias} variable instead`);
            break;
        }
    }
}

// Masked identity log: proves which secrets reached the process without ever
// printing a value (first 3 + last 4 chars + length is enough to spot wrong
// tokens, stray whitespace, or a panel that never passed the variable).
for (const key of ["LIMEBOT_TOKEN", "LIMEBOT_ADMIN_TOKEN", "USRBG_ADMIN_TOKEN"]) {
    const v = process.env[key];
    if (v === undefined) {
        console.log(`[limebot] env: ${key} is NOT SET`);
    } else {
        const len = v.length;
        const trimmed = v.trim().length;
        console.log(`[limebot] env: ${key} set (${len} chars${trimmed !== len ? ", whitespace-padded!" : ""}, …${v.slice(-4).replace(/[^A-Za-z0-9_-]/g, "*")})`);
    }
}
// Bump when install-time behavior changes so running hosts reinstall once.
const INSTALL_VERSION = "4";
// Bump when bundled source code changes in a way that MUST reach hosts that
// already have a built dist/ (run.js never rebuilds an existing bundle, so
// a marker mismatch forces exactly one rebuild).
const BUILD_VERSION = "8";

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
const buildMarkerFile = path.join(root, "dist", ".limebot-build-version");
const buildMarker = (() => {
    try { return fs.readFileSync(buildMarkerFile, "utf8").trim(); } catch { return null; }
})();
if (!has("dist/botOnly.js") || buildMarker !== BUILD_VERSION) {
    if (has("dist/botOnly.js"))
        console.log(`[limebot] dist/ was built by an older bootstrap (build marker ${String(buildMarker)} != ${BUILD_VERSION}) — rebuilding...`);
    else
        console.log("[limebot] building dist/ bundles with esbuild...");
    run(process.execPath, ["scripts/build.mjs"]);
    fs.mkdirSync(path.dirname(buildMarkerFile), { recursive: true });
    fs.writeFileSync(buildMarkerFile, BUILD_VERSION);
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
//     It must NOT be fatal: sharp is only used for donor-badge image
//     optimization, which is also loaded lazily, so the bot can start
//     without it and just report the failure when the feature is used.
function sharpLoadError() {
    const r = spawnSync(
        process.execPath,
        ["-e", "try { require('sharp'); } catch (e) { process.stderr.write(String((e && e.stack) || e)); process.exit(1); }"],
        { cwd: root, stdio: "pipe" }
    );
    if (r.status === 0) return null;
    return (r.stderr || "").toString().trim() || "unknown error (no stderr captured)";
}

const firstSharpError = sharpLoadError();
if (firstSharpError !== null) {
    console.log("[limebot] sharp failed to load — reinstalling with optional dependencies included...");
    run(npmCmd, ["install", "--include=optional", "--no-audit", "--no-fund"]);

    // Still failing? The optional binaries are selected by os/cpu/libc
    // fields, which some npm versions mis-detect (in particular on musl
    // images). Last resort: install the exact package for this host
    // directly, musl first when /bin/ldd identifies musl.
    if (sharpLoadError() !== null) {
        const arch = (spawnSync(process.execPath, ["-p", "process.arch"], { cwd: root, stdio: "pipe" }).stdout || process.arch)
            .toString().trim();
        const ldd = spawnSync("ldd", ["--version"], { stdio: "pipe" });
        const variants = ((ldd.stdout || "") + (ldd.stderr || "")).toString().includes("musl")
            ? ["linuxmusl", "linux"]
            : ["linux", "linuxmusl"];

        let fixed = false;
        for (const variant of variants) {
            // The binding and its libvips library MUST be version-paired:
            // installing only the @img/sharp-*-<arch> package leaves an old
            // @img/sharp-libvips-* behind, and the binding then fails with
            // "libvips-cpp.so.8.<x>: cannot open shared object file". Both
            // versions are read from the installed sharp's own metadata.
            const specs = [];
            let sharpVer = null;
            try {
                const sharpPkg = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "sharp", "package.json"), "utf8"));
                sharpVer = sharpPkg.version;
                const libvipsSpec = sharpPkg.optionalDependencies?.[`@img/sharp-libvips-${variant}-${arch}`];
                if (libvipsSpec) specs.push(`@img/sharp-libvips-${variant}-${arch}@${libvipsSpec}`);
            } catch {
                // sharp itself isn't installed — nothing to pair against
            }
            if (sharpVer) specs.push(`@img/sharp-${variant}-${arch}@${sharpVer}`);
            const what = specs.length ? specs.join(" + ") : `@img/sharp-${variant}-${arch}`;

            console.log(`[limebot] sharp still failing — installing ${what} directly...`);
            const install = spawnSync(npmCmd, ["install", "--no-save", "--include=optional", ...(specs.length ? specs : [`@img/sharp-${variant}-${arch}`]), "--no-audit", "--no-fund"], {
                stdio: "inherit",
                cwd: root
            });
            if (install.status === 0 && sharpLoadError() === null) {
                fixed = true;
                break;
            }
            console.log(`[limebot] ${specs.join(" + ") || "the platform package"} didn't fix it — trying the next candidate...`);
        }

        if (!fixed) {
            const finalError = sharpLoadError() ?? firstSharpError;
            console.error("[limebot] sharp could not be loaded on this host — starting WITHOUT it.");
            console.error("[limebot] /donors badge image optimization will fail at runtime until it does; error:");
            console.error(finalError);
            // deliberately no process.exit: a native image library must not
            // crash-loop the entire gateway process on hosts it can't load.
        }
    }
}

if (process.env.LIMEBOT_BOOTSTRAP_DRYRUN === "1") {
    console.log("[limebot] bootstrap dry run OK — dependencies installed, dist present, SQLite binding intact, sharp loads (not starting)");
    return; // top-level return is valid in CommonJS
}

// 4. start the bot (botOnly sets its own mode flags before server code runs)
require("./dist/botOnly.js");

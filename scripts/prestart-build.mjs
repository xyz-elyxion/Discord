/**
 * Limey V1 — prestart build script
 *
 * Runs before `npm start` / `pnpm start` and builds whatever artifacts are
 * missing (browser extension / userscript via `pnpm buildWeb`, Discord
 * Desktop App bundles via `pnpm build`), installing devDependencies first
 * if node_modules is incomplete. If everything is already built, this is a
 * fast no-op so startup stays snappy.
 *
 * Skipped entirely when LIMEY_SKIP_BUILD=1 is set.
 */
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const WEB_ARTIFACTS = ["dist/browser.js", "dist/LimeyV1.user.js"];
const DESKTOP_ARTIFACTS = ["dist/patcher.js", "dist/renderer.js", "dist/preload.js"];

function newestMtime(paths) {
    let newest = 0;
    for (const p of paths) {
        if (!existsSync(p)) continue;
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
    }
    return newest;
}

// Source newer than the artifacts? Then rebuild even if they exist.
const sourceFiles = ["src", "browser", "scripts/build", "package.json"];

function isStale(artifacts) {
    // missing any artifact, or any source file newer than the newest artifact
    if (artifacts.some(p => !existsSync(p))) return true;
    return newestMtime(sourceFiles) > newestMtime(artifacts);
}

function run(cmd, args) {
    console.log(`[prestart] ${cmd} ${args.join(" ")} ...`);
    const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    if (res.status !== 0) {
        console.error(`[prestart] command failed with exit code ${res.status}`);
        process.exit(res.status ?? 1);
    }
}

if (process.env.LIMEY_SKIP_BUILD === "1") {
    console.log("[prestart] LIMEY_SKIP_BUILD=1 — skipping build check");
    process.exit(0);
}

if (!existsSync("scripts/build/buildWeb.mjs")) {
    console.log("[prestart] no build source available — starting server as-is");
    process.exit(0);
}

if (!existsSync("node_modules/esbuild")) {
    run("pnpm", ["install", "--no-frozen-lockfile"]);
}

// Standalone builds use the HTTP updater (against this site) instead of git,
// which installed clients don't have. Resolve the hash so builds are stamped
// correctly (falls back to git locally, "unknown" otherwise).
process.env.LIMEYV1_HASH ||= (() => {
    try {
        return require("node:child_process").execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    } catch {
        return "unknown";
    }
})();

let didBuild = false;
if (isStale(WEB_ARTIFACTS)) {
    run("pnpm", ["buildWeb", "--standalone"]); // browser extension + userscript + zip
    didBuild = true;
} else {
    console.log("[prestart] web bundles up to date");
}

if (isStale(DESKTOP_ARTIFACTS)) {
    run("pnpm", ["build", "--standalone"]); // Discord Desktop App bundles
    didBuild = true;
} else {
    console.log("[prestart] desktop bundles up to date");
}

if (!didBuild) console.log("[prestart] all bundles up to date — starting server");

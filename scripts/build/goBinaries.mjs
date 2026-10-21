#!/usr/bin/env node
/*
 * Limey V1 — hosting build helper.
 *
 * The Freebuff/Render-style hosting builder is a Node.js-only image with the
 * Go toolchain available but no Go module cache warmed for our module paths.
 * This script cross-compiles EVERY Go artifact the deployment needs:
 *
 *   cloud/limeycloud-backend  settings-sync cloud API (spawned by server.js)
 *   dist/LimeyV1Installer-cli-{win,macos-arm64,macos-amd64,linux}
 *                             CLI installers served at /dist/ — same matrix
 *                             as the Dockerfile's installer stage, so edits
 *                             under installer/ reach the deployed site on
 *                             the next regular deploy (no cache clear).
 *
 * Rules:
 *  - CGO off, static, one GOOS/GOARCH pair per target (override via env).
 *  - Errors are logged but NEVER fail the hosting build: cloud/installers
 *    are optional runtimes and server.js/public pages already degrade
 *    gracefully ("[cloud] binary not found", 404 download) when absent.
 *  - Idempotent: skips rebuild when the binary is newer than its sources.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const GOOS = process.env.GOHOST_BIN_GOOS || "linux";
const GOARCH = process.env.GOHOST_BIN_GOARCH || "amd64";

const TARGETS = [
    // linux/amd64 — the runtime container's arch (spawned by server.js).
    { dir: "cloud", pkg: ".", out: "limeycloud-backend", env: { GOOS: "linux", GOARCH: "amd64" } },
    // Installer downloads served from /dist/LimeyV1Installer* — same matrix
    // as the Dockerfile's installer stage. CLI builds are CGO-free static.
    { dir: "installer", pkg: ".", out: "dist/LimeyV1Installer-cli-win.exe", env: { GOOS: "windows", GOARCH: "amd64", TAGS: ["cli"] } },
    { dir: "installer", pkg: ".", out: "dist/LimeyV1Installer-cli-macos-arm64", env: { GOOS: "darwin", GOARCH: "arm64", TAGS: ["cli"] } },
    { dir: "installer", pkg: ".", out: "dist/LimeyV1Installer-cli-macos-amd64", env: { GOOS: "darwin", GOARCH: "amd64", TAGS: ["cli"] } },
    { dir: "installer", pkg: ".", out: "dist/LimeyV1Installer-cli-linux", env: { GOOS: "linux", GOARCH: "amd64", TAGS: ["cli"] } }
];

function newerThanSources(dir, out) {
    const outPath = targetOutPath(dir, out);
    if (!existsSync(outPath)) return false;
    const outTime = statSync(outPath).mtimeMs;
    try {
        const src = execFileSync("git", ["-C", join(ROOT, dir), "ls-files"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        for (const f of src.split("\n")) {
            if (!f) continue;
            const p = join(ROOT, dir, f);
            if (existsSync(p) && statSync(p).mtimeMs > outTime) return false;
        }
        return true;
    } catch {
        return false; // not a git checkout (or git missing) — rebuild
    }
}

function probeGo() {
    if (process.env.GOBIN || process.env.PATH?.includes("go")) return "go";
    for (const candidate of ["/usr/local/go/bin/go", "/usr/bin/go", "/usr/lib/go/bin/go"]) {
        if (existsSync(candidate)) {
            process.env.PATH = `${dirname(candidate)}:${process.env.PATH || ""}`;
            return candidate;
        }
    }
    return null;
}

// Outputs starting with "dist/" land in the project's dist/ (what the
// runtime stage serves at /dist/*); anything else stays inside the target dir.
function targetOutPath(dir, out) {
    return out.startsWith("dist/") ? join(ROOT, out) : join(ROOT, dir, out);
}

function tryGo(toolDesc, dir, pkg, out, targetEnv) {
    const go = probeGo();
    if (!go) {
        console.warn(`[gobinaries] no Go toolchain found — ${toolDesc} skipped (hosting build continues; ${dir} runtime will degrade gracefully)`);
        return;
    }
    const outPath = targetOutPath(dir, out);
    mkdirSync(dirname(outPath), { recursive: true });
    const mergedEnv = { ...process.env, CGO_ENABLED: "0", ...(targetEnv || {}) };
    if (!mergedEnv.GOCACHE) mergedEnv.GOCACHE = join(ROOT, ".gocache");
    const args = ["build", "-trimpath"];
    if (targetEnv?.TAGS?.length) args.push("-tags", targetEnv.TAGS.join(","));
    if (targetEnv?.LDFLAGS) args.push("-ldflags", targetEnv.LDFLAGS);
    args.push("-o", outPath, pkg);
    try {
        execFileSync("go", args, {
            cwd: join(ROOT, dir),
            env: mergedEnv,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 300_000
        });
        console.log(`[gobinaries] built ${dir}/${out} (${mergedEnv.GOOS}/${mergedEnv.GOARCH}) -> ${outPath.replace(join(ROOT) + "/", "")}`);
    } catch (err) {
        const msg = err?.stderr?.toString?.().trim() || err?.message || String(err);
        console.warn(`[gobinaries] ${toolDesc} failed (hosting build continues; ${dir} runtime will degrade gracefully): ${msg.split("\n").slice(-3).join(" | ")}`);
    }
}

for (const t of TARGETS) {
    if (!existsSync(join(ROOT, t.dir, "go.mod"))) {
        console.log(`[gobinaries] skip ${t.dir} — no go.mod (source not present)`);
        continue;
    }
    if (newerThanSources(t.dir, t.out)) {
        console.log(`[gobinaries] skip ${targetOutPath(t.dir, t.out).replace(join(ROOT) + "/", "")} — up to date`);
        continue;
    }
    tryGo(t.dir, t.dir, t.pkg, t.out, t.env);
}

// Windows GUI installer: needs mingw-w64 for the cgo build. Present in the
// Docker installer stage; usually absent on Node.js-only hosting builders,
// where it's skipped with a notice instead of failing the build.
if (existsSync(join(ROOT, "installer", "go.mod")) && !newerThanSources("installer", "dist/LimeyV1Installer.exe")) {
    tryGo("Windows GUI installer (mingw)", "installer", ".", "dist/LimeyV1Installer.exe", {
        GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "1",
        CC: "x86_64-w64-mingw32-gcc", CXX: "x86_64-w64-mingw32-g++",
        LDFLAGS: "-H windowsgui -s -w"
    });
}

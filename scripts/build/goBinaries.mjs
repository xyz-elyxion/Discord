#!/usr/bin/env node
/*
 * Limey V1 — hosting build helper.
 *
 * The Freebuff/Render-style hosting builder is a Node.js-only image with the
 * Go toolchain available but no Go module cache warmed for our module paths.
 * This script cross-compiles the two Go helpers that server.js spawns:
 *
 *   sent/sentinel-server   (Limey Guard — PoW anti-bot)
 *   cloud/limeycloud-backend (settings-sync cloud API)
 *
 * Rules:
 *  - CGO off, static, linux/amd64 by default (override via GOHOST_BIN_GOOS/GOARCH)
 *  - Errors are logged but NEVER fail the hosting build: Guard/cloud are
 *    optional runtimes and server.js already degrades gracefully (503 for
 *    Guard, "[cloud] binary not found" for the backend) when they are absent.
 *  - Idempotent: skips rebuild when the binary is newer than its sources.
 */

import { execFileSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const GOOS = process.env.GOHOST_BIN_GOOS || "linux";
const GOARCH = process.env.GOHOST_BIN_GOARCH || "amd64";

const TARGETS = [
    { dir: "sent", pkg: "./cmd/server", out: "sentinel-server" },
    { dir: "cloud", pkg: ".", out: "limeycloud-backend" }
];

function newerThanSources(dir, out) {
    const outPath = join(ROOT, dir, out);
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

function tryGo(toolDesc, dir, pkg, out) {
    if (!process.env.GOBIN && !process.env.PATH?.includes("go")) {
        // Try common locations before giving up (best-effort tool probe).
        for (const candidate of ["/usr/local/go/bin/go", "/usr/bin/go", "/usr/lib/go/bin/go"]) {
            if (existsSync(candidate)) {
                process.env.PATH = `${dirname(candidate)}:${process.env.PATH || ""}`;
                break;
            }
        }
    }
    const outPath = join(ROOT, dir, out);
    try {
        execFileSync("go", ["build", "-trimpath", "-o", outPath, pkg], {
            cwd: join(ROOT, dir),
            env: {
                ...process.env,
                CGO_ENABLED: "0",
                GOOS,
                GOARCH,
                GOCACHE: process.env.GOCACHE || join(ROOT, ".gocache"),
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 300_000
        });
        console.log(`[gobinaries] built ${dir}/${out} (${GOOS}/${GOARCH})`);
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
        console.log(`[gobinaries] skip ${t.dir}/${t.out} — up to date`);
        continue;
    }
    tryGo(t.dir, t.dir, t.pkg, t.out);
}

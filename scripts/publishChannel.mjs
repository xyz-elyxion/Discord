/*
 * Publish (freeze) a release-channel snapshot.
 *
 * Release channels with frozen build artifacts — LTS, RC and Beta — are
 * served by the backend from dist/<channel>/. This script is the publishing
 * step: it copies the current desktop build files from dist/ into
 * dist/<channel>/, hash stamps and all, so the channel serves exactly this
 * build until the next freeze.
 *
 * Semantics (see docs/release-channels and server.js):
 *   lts        — falls back to the current stable files until a pin exists,
 *                so freezing sets the long-support point explicitly.
 *   rc / beta  — pre-release snapshots of the NEXT version; the backend
 *                answers 503 until a snapshot exists, never substituting
 *                stable files (stable is older than a pre-release).
 *
 * Usage:
 *   node scripts/publishChannel.mjs <lts|rc|beta|canary|alpha> [--force]
 *
 * --force is required to replace an existing snapshot, so accidental runs
 * don't silently re-point a live LTS/LTS-like channel at a new build.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");

const CHANNELS = ["lts", "rc", "beta", "canary", "alpha"];
// Same files the Go installer downloads (installer/constants.go BuildFiles).
const FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];

const channel = process.argv[2];
const force = process.argv.includes("--force");

if (!channel || !CHANNELS.includes(channel)) {
    console.error(`[publish-channel] usage: node scripts/publishChannel.mjs <${CHANNELS.join("|")}> [--force]`);
    process.exit(1);
}

for (const file of FILES) {
    if (readFileSyncSafe(join(DIST, file))) continue;
    console.error(`[publish-channel] dist/${file} missing — run "pnpm build --standalone" before freezing a channel.`);
    process.exit(1);
}

const snapshotDir = join(DIST, channel);
const existingHash = readHash(join(snapshotDir, "patcher.js"));
const targetHash = readHash(join(DIST, "patcher.js"));

if (existingHash && !force) {
    console.error(
        `[publish-channel] dist/${channel}/ already holds a frozen snapshot (hash ${existingHash}).\n` +
        "Re-running --force would re-point a live channel at a new build. If you really mean to, add --force."
    );
    process.exit(1);
}

mkdirSync(snapshotDir, { recursive: true });
for (const file of FILES) {
    copyFileSync(join(DIST, file), join(snapshotDir, file));
}

console.log(`[publish-channel] froze ${channel} snapshot at hash ${targetHash ?? "unknown"} -> dist/${channel}/`);
if (channel === "rc") console.log("[publish-channel] rc channel is live until the next freeze (usually folded into stable first).");
if (channel === "beta") console.log("[publish-channel] beta channel is live until the next freeze (per feature batch).");
if (channel === "canary") console.log("[publish-channel] canary channel is live until the next freeze (freshest shipped pre-release). Do not confuse it with the discord-canary host branch.");
if (channel === "alpha") console.log("[publish-channel] alpha channel is live until the next freeze (earliest shipped pre-release). Re-freeze fresh batches; expect breakage.");
if (channel === "lts") console.log("[publish-channel] lts channel pinned; the backend now serves dist/lts/ instead of falling back to stable.");

function readFileSyncSafe(file) {
    try {
        return Boolean(readFileSync(file));
    } catch {
        return false;
    }
}

function readHash(patcherPath) {
    try {
        const head = readFileSync(patcherPath, "utf8").slice(0, 64);
        return /^\/\/ Limey V1 (\S+)/.exec(head)?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * MCP server for Limey V1. Lets an agent read the checkout it is pointed at:
 * plugins, their settings, the plugin APIs and any source file.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories that never hold the source an agent is looking for. */
const IGNORED_DIRS = new Set([
    ".git",
    ".next",
    ".turbo",
    ".venv",
    "ExtensionCache",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules"
]);

const BINARY_EXTENSIONS = new Set([
    "avif", "bmp", "bz2", "db", "eot", "exe", "gif", "gz", "ico", "jar", "jpeg", "jpg", "mp3", "mp4",
    "ogg", "otf", "pdf", "png", "sqlite", "sqlite3", "tar", "ttf", "wasm", "webm", "webp", "woff",
    "woff2", "zip", "7z"
]);

export class RepoError extends Error {}

let cachedRoot: string | undefined;

function isLimeyCheckout(directory: string): boolean {
    return existsSync(join(directory, "src", "plugins"))
        && existsSync(join(directory, "src", "api"))
        && existsSync(join(directory, "package.json"));
}

/**
 * The checkout to serve. `LIMEY_V1_ROOT` wins, otherwise the repository this server was
 * built in is used, so `npx limey-v1-mcp-server` works from inside a Limey V1 clone.
 */
export function repoRoot(): string {
    if (cachedRoot) return cachedRoot;

    const candidates = [
        process.env.LIMEY_V1_ROOT ? resolve(process.env.LIMEY_V1_ROOT) : undefined,
        // src/repo.ts and dist/repo.js are both two levels below the repository root
        resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
        resolve(process.cwd())
    ].filter((candidate): candidate is string => candidate !== undefined);

    const found = candidates.find(isLimeyCheckout);
    if (!found) {
        throw new RepoError(
            "Could not find a Limey V1 checkout. Set LIMEY_V1_ROOT to the repository root "
            + "(the folder that contains src/plugins and src/api). Tried: " + candidates.join(", ")
        );
    }

    cachedRoot = found;
    return found;
}

/** Converts an absolute path inside the checkout into a stable, posix-style repo path. */
export function repoPath(absolutePath: string): string {
    return relative(repoRoot(), absolutePath).split(sep).join("/");
}

/** Resolves a repo path, refusing anything that would leave the checkout. */
export function resolveRepoPath(path: string): string {
    if (path.includes("\0")) throw new RepoError("Paths may not contain NUL bytes.");

    if (isAbsolute(path)) {
        throw new RepoError(`Expected a path relative to the Limey V1 checkout, got an absolute path: ${path}`);
    }

    const target = resolve(repoRoot(), path);
    const relativeTarget = relative(repoRoot(), target);
    if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
        throw new RepoError(`Path escapes the Limey V1 checkout: ${path}`);
    }

    return target;
}

export function isBinaryPath(path: string): boolean {
    const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return path.includes(".") && BINARY_EXTENSIONS.has(extension);
}

export interface RepoFileRead {
    path: string;
    text: string;
    bytes: number;
    truncated: boolean;
    lines: number;
}

/**
 * Reads a text file. Large files are cut at `maxBytes` instead of being loaded whole, so a
 * stray bundler output cannot stall the server.
 */
export function readRepoFile(path: string, maxBytes = 200_000): RepoFileRead {
    const absolute = resolveRepoPath(path);

    let stats;
    try {
        stats = statSync(absolute);
    } catch {
        throw new RepoError(`File not found in the checkout: ${path}. Use limey_search_source to find the right path.`);
    }

    if (!stats.isFile()) throw new RepoError(`${path} is a directory, not a file. Use limey_get_plugin or limey_list_apis to see what is inside.`);
    if (isBinaryPath(path)) throw new RepoError(`${path} is a binary file; this server only reads text files.`);

    let buffer: Buffer;
    if (stats.size <= maxBytes) {
        buffer = readFileSync(absolute);
    } else {
        const descriptor = openSync(absolute, "r");
        try {
            buffer = Buffer.alloc(maxBytes);
            const read = readSync(descriptor, buffer, 0, maxBytes, 0);
            buffer = buffer.subarray(0, read);
        } finally {
            closeSync(descriptor);
        }
    }

    // A byte cut can land inside a multi-byte character; drop the replacement character it leaves.
    const text = buffer.toString("utf8").replace(/\uFFFD$/, "");

    return {
        path: repoPath(absolute),
        text,
        bytes: stats.size,
        truncated: stats.size > maxBytes,
        lines: text.split("\n").length
    };
}

export interface FileEntry {
    path: string;
    bytes: number;
}

/** Recursively lists files below a repo path, skipping build output and dependencies. */
export function listFilesRecursive(path: string, maxFiles = 1000): FileEntry[] {
    const absolute = resolveRepoPath(path);

    let stats;
    try {
        stats = statSync(absolute);
    } catch {
        throw new RepoError(`Path not found in the checkout: ${path}`);
    }

    if (stats.isFile()) return [{ path: repoPath(absolute), bytes: stats.size }];

    const files: FileEntry[] = [];

    const visit = (directory: string) => {
        const entries = readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
            if (files.length >= maxFiles) return;

            const full = join(directory, entry.name);

            if (entry.isDirectory()) {
                if (!IGNORED_DIRS.has(entry.name)) visit(full);
                continue;
            }

            if (!entry.isFile()) continue;

            try {
                files.push({ path: repoPath(full), bytes: statSync(full).size });
            } catch {
                // the file vanished while walking; nothing to report
            }
        }
    };

    visit(absolute);
    return files;
}

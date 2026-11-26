/** Index of the APIs Limey V1 plugins can import from `@api/*`. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { RepoError, readRepoFile, repoPath, repoRoot } from "./repo.js";

export interface ApiExport {
    name: string;
    kind: string;
    summary?: string;
}

export interface ApiModule {
    name: string;
    path: string;
    exports: ApiExport[];
}

let apiCache: ApiModule[] | undefined;

export function getApiModules(): ApiModule[] {
    apiCache ??= loadApiModules();
    return apiCache;
}

export function findApiModule(requested: string): ApiModule {
    const needle = requested.trim().toLowerCase().replace(/^@api\//, "").replace(/\.tsx?$/, "");
    const modules = getApiModules();

    const exact = modules.find(module =>
        module.name.toLowerCase() === needle || module.path.toLowerCase() === needle
    );
    if (exact) return exact;

    const similar = modules
        .filter(module => module.name.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(module => module.name);

    throw new RepoError(
        `No API module named "${requested}" under src/api.`
        + (similar.length ? ` Did you mean: ${similar.join(", ")}?` : " Use limey_list_apis to browse the API index.")
    );
}

function loadApiModules(): ApiModule[] {
    const directory = join(repoRoot(), "src", "api");

    const modules: ApiModule[] = [];
    for (const dirent of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (dirent.name.startsWith(".")) continue;

        const full = join(directory, dirent.name);
        const entry = dirent.isDirectory()
            ? [join(full, "index.ts"), join(full, "index.tsx")].find(candidate => existsSync(candidate))
            : /^[^_].*\.tsx?$/.test(dirent.name) && !/^index\.tsx?$/.test(dirent.name)
                ? full
                : undefined;

        if (!entry || !statSync(entry).isFile()) continue;

        modules.push({
            name: dirent.isDirectory() ? dirent.name : dirent.name.replace(/\.tsx?$/, ""),
            path: repoPath(entry),
            exports: parseExports(readRepoFile(repoPath(entry), 400_000).text)
        });
    }

    return modules;
}

const EXPORT_PATTERN = /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const REEXPORT_PATTERN = /^export\s+(?:\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?|\{([^}]*)\})\s*from\s*["'][^"']+["']/gm;

export function parseExports(source: string): ApiExport[] {
    const exports: ApiExport[] = [];
    const seen = new Set<string>();

    const add = (name: string, kind: string, index: number) => {
        const trimmed = name.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        exports.push({ name: trimmed, kind, summary: summarize(source, index) });
    };

    for (const match of source.matchAll(EXPORT_PATTERN)) {
        add(match[2], match[1], match.index ?? 0);
    }

    for (const match of source.matchAll(REEXPORT_PATTERN)) {
        if (match[1]) {
            add(match[1], "reexport", match.index ?? 0);
            continue;
        }

        for (const name of (match[2] ?? "").split(",")) {
            const cleaned = name.trim().split(/\s+as\s+/).pop()?.trim();
            if (cleaned) add(cleaned, "reexport", match.index ?? 0);
        }
    }

    return exports.sort((a, b) => a.name.localeCompare(b.name));
}

/** The JSDoc block directly above an export, collapsed into at most three lines. */
function summarize(source: string, index: number): string | undefined {
    const before = source.slice(0, index);
    const commentEnd = before.lastIndexOf("*/");
    if (commentEnd === -1) return undefined;

    if (before.slice(commentEnd + 2).trim() !== "") return undefined;

    const commentStart = before.lastIndexOf("/**", commentEnd);
    if (commentStart === -1) return undefined;

    const lines = before
        .slice(commentStart + 3, commentEnd)
        .split("\n")
        .map(line => line.replace(/^\s*\*?\s?/, "").trim())
        .filter(Boolean)
        .slice(0, 3);

    return lines.length ? lines.join(" ") : undefined;
}

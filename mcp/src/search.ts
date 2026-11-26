/** Text search across the checkout. */

import { escapeRegExp } from "./format.js";
import { RepoError, isBinaryPath, listFilesRecursive, readRepoFile } from "./repo.js";

const MAX_FILE_BYTES = 1_500_000;

export interface SearchOptions {
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    path: string;
    include: string;
    maxResults: number;
    contextLines: number;
}

export interface SearchMatch {
    path: string;
    line: number;
    text: string;
    context?: string[];
}

export interface SearchResult {
    matches: SearchMatch[];
    filesScanned: number;
    truncated: boolean;
}

export function searchSource(options: SearchOptions): SearchResult {
    const pattern = buildPattern(options);
    const queryPath = options.path.trim() || "src";
    const include = globToRegExp(options.include);

    const files = listFilesRecursive(queryPath, 5000)
        .filter(file => !isBinaryPath(file.path))
        .filter(file => file.bytes <= MAX_FILE_BYTES)
        .filter(file => include.test(file.path));

    const matches: SearchMatch[] = [];
    let filesScanned = 0;

    for (const file of files) {
        let text: string;
        try {
            text = readRepoFile(file.path, MAX_FILE_BYTES).text;
        } catch {
            continue;
        }

        filesScanned++;
        const lines = text.split("\n");

        for (let index = 0; index < lines.length; index++) {
            pattern.lastIndex = 0;
            if (!pattern.test(lines[index])) continue;

            if (matches.length >= options.maxResults) {
                return { matches, filesScanned, truncated: true };
            }

            const match: SearchMatch = { path: file.path, line: index + 1, text: lines[index].slice(0, 400) };

            if (options.contextLines > 0) {
                const start = Math.max(0, index - options.contextLines);
                const end = Math.min(lines.length, index + options.contextLines + 1);
                match.context = lines.slice(start, end).map(line => line.slice(0, 400));
            }

            matches.push(match);
        }
    }

    return { matches, filesScanned, truncated: false };
}

function buildPattern(options: SearchOptions): RegExp {
    const source = options.regex ? options.query : escapeRegExp(options.query);

    try {
        return new RegExp(source, options.caseSensitive ? "" : "i");
    } catch (error) {
        throw new RepoError(
            `Invalid regular expression: ${(error as Error).message}. `
            + "Set regex=false to search for the text literally."
        );
    }
}

/** Small glob matcher: `**`, `*`, `?` and `{a,b}`, matched against repo-relative paths. */
export function globToRegExp(glob: string): RegExp {
    const trimmed = glob.trim();
    if (!trimmed || trimmed === "**" || trimmed === "**/*") return /^.*$/;

    let output = "";

    for (let index = 0; index < trimmed.length; index++) {
        const char = trimmed[index];

        if (char === "*") {
            if (trimmed[index + 1] === "*") {
                index++;
                if (trimmed[index + 1] === "/") {
                    index++;
                    output += "(?:.*/)?";
                } else {
                    output += ".*";
                }
            } else {
                output += "[^/]*";
            }
            continue;
        }

        if (char === "?") {
            output += "[^/]";
            continue;
        }

        if (char === "{") {
            const end = trimmed.indexOf("}", index);
            if (end === -1) {
                output += "\\{";
                continue;
            }

            const alternatives = trimmed
                .slice(index + 1, end)
                .split(",")
                .map(alternative => escapeRegExp(alternative.trim()))
                .join("|");

            output += `(?:${alternatives})`;
            index = end;
            continue;
        }

        output += escapeRegExp(char);
    }

    return new RegExp(`^${output}$`);
}


/** Reads the plugin catalogue and the source facts (settings, permissions, imports) behind it. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { escapeRegExp } from "./format.js";
import { RepoError, listFilesRecursive, readRepoFile, repoPath, repoRoot, resolveRepoPath } from "./repo.js";

export interface PluginAuthor {
    name: string;
    id: string;
}

export interface PluginRecord {
    name: string;
    description: string;
    tags: string[];
    searchTerms: string[];
    authors: PluginAuthor[];
    dependencies: string[];
    hasPatches: boolean;
    hasCommands: boolean;
    required: boolean;
    enabledByDefault: boolean;
    target?: string;
    filePath: string;
    /** false when the plugin was found on disk but is missing from web/public/plugins.json */
    indexed: boolean;
}

export interface PluginSetting {
    key: string;
    type?: string;
    description?: string;
    default?: string;
    restartNeeded: boolean;
}

export interface PluginPermission {
    id: string;
    title?: string;
    risk?: string;
}

export interface PluginFile {
    path: string;
    bytes: number;
}

export interface PluginLocation {
    directory: string;
    entry: string;
    files: PluginFile[];
}

export interface PluginDetails {
    plugin: PluginRecord;
    location: PluginLocation;
    readme?: string;
    settings: PluginSetting[];
    permissions: PluginPermission[];
    imports: string[];
}

let pluginCache: PluginRecord[] | undefined;
let readmeCache: Record<string, string> | undefined;

export function getPlugins(): PluginRecord[] {
    pluginCache ??= loadPlugins();
    return pluginCache;
}

export function findPlugin(requested: string): PluginRecord {
    const needle = requested.trim().toLowerCase();
    const plugins = getPlugins();

    const exact = plugins.find(plugin =>
        plugin.name.toLowerCase() === needle || plugin.filePath.toLowerCase() === needle
    );
    if (exact) return exact;

    const suffixed = plugins.find(plugin =>
        plugin.filePath.toLowerCase().replace(/\.tsx?$/, "") === needle
    );
    if (suffixed) return suffixed;

    const similar = plugins
        .filter(plugin => plugin.name.toLowerCase().includes(needle))
        .slice(0, 8)
        .map(plugin => plugin.name);

    throw new RepoError(
        `No plugin named "${requested}" in this checkout.`
        + (similar.length ? ` Did you mean: ${similar.join(", ")}?` : " Use limey_list_plugins to browse the catalogue.")
    );
}

export function getPluginDetails(plugin: PluginRecord): PluginDetails {
    const location = getPluginLocation(plugin);
    const details: PluginDetails = {
        plugin,
        location,
        readme: getPluginReadme(plugin, location),
        settings: [],
        permissions: [],
        imports: []
    };

    const sources = location.files
        .filter(file => /\.tsx?$/.test(file.path) && file.bytes < 300_000)
        .slice(0, 25);

    const seenSettings = new Set<string>();
    const seenPermissions = new Set<string>();
    const imports = new Set<string>();

    for (const file of sources) {
        const { text } = readRepoFile(file.path, 300_000);

        for (const setting of parseSettings(text)) {
            if (seenSettings.has(setting.key)) continue;
            seenSettings.add(setting.key);
            details.settings.push(setting);
        }

        for (const permission of parsePermissions(text)) {
            if (seenPermissions.has(permission.id)) continue;
            seenPermissions.add(permission.id);
            details.permissions.push(permission);
        }

        for (const module of collectImports(text)) imports.add(module);
    }

    details.imports = [...imports].sort();
    return details;
}

export function getPluginLocation(plugin: PluginRecord): PluginLocation {
    const base = `src/plugins/${plugin.filePath}`;
    const absoluteBase = resolveRepoPath(base);
    const baseStats = statSync(absoluteBase, { throwIfNoEntry: false });
    const isFolder = baseStats?.isDirectory() === true;

    const entry = (isFolder
        ? [join(absoluteBase, "index.ts"), join(absoluteBase, "index.tsx")]
        : [absoluteBase, `${absoluteBase}.ts`, `${absoluteBase}.tsx`]
    ).find(candidate => existsSync(candidate) && statSync(candidate).isFile());

    if (!entry) {
        throw new RepoError(
            `Plugin "${plugin.name}" is listed in the plugin index but ${base} does not exist in this checkout. `
            + "Run \"pnpm generatePluginJson\" to refresh the index, or check that LIMEY_V1_ROOT points at the right folder."
        );
    }

    const entryStats = statSync(entry);

    return {
        directory: repoPath(isFolder ? absoluteBase : dirname(entry)),
        entry: repoPath(entry),
        files: isFolder
            ? listFilesRecursive(repoPath(absoluteBase), 200)
            : [{ path: repoPath(entry), bytes: entryStats.size }]
    };
}

export function getPluginReadmeByName(name: string): string | undefined {
    const plugin = getPlugins().find(entry => entry.name.toLowerCase() === name.toLowerCase());
    if (!plugin) return undefined;

    return getPluginReadme(plugin, getPluginLocation(plugin));
}

export function getPluginReadme(plugin: PluginRecord, location: PluginLocation): string | undefined {
    const readmes = loadReadmes();
    const cached = readmes[plugin.name];
    if (cached) return cached;

    const candidate = `${location.directory}/README.md`;
    if (!existsSync(resolveRepoPath(candidate))) return undefined;

    return readRepoFile(candidate, 200_000).text;
}

// ---- catalogue ----

function loadPlugins(): PluginRecord[] {
    const indexed = loadPluginIndex();
    const byName = new Map(indexed.map(plugin => [plugin.name.toLowerCase(), plugin]));

    for (const entry of collectPluginEntryPaths()) {
        const fallback = readFallbackRecord(entry);
        if (!byName.has(fallback.name.toLowerCase())) byName.set(fallback.name.toLowerCase(), fallback);
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function loadPluginIndex(): PluginRecord[] {
    const indexPath = "web/public/plugins.json";
    if (!existsSync(resolveRepoPath(indexPath))) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(readRepoFile(indexPath, 4_000_000).text);
    } catch (error) {
        throw new RepoError(
            `Could not parse ${indexPath}: ${(error as Error).message}. `
            + "Run \"pnpm generatePluginJson\" to regenerate it, or delete it to let this server scan src/plugins directly."
        );
    }

    if (!Array.isArray(parsed)) {
        throw new RepoError(`${indexPath} is not an array of plugins. Run "pnpm generatePluginJson" to regenerate it.`);
    }

    return parsed
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .filter(entry => typeof entry.name === "string" && typeof entry.filePath === "string")
        .map(entry => ({
            name: entry.name as string,
            description: typeof entry.description === "string" ? entry.description : "",
            tags: stringArray(entry.tags),
            searchTerms: stringArray(entry.searchTerms),
            authors: Array.isArray(entry.authors)
                ? entry.authors
                    .filter((author): author is Record<string, unknown> => !!author && typeof author === "object")
                    .filter(author => typeof author.name === "string")
                    .map(author => ({ name: author.name as string, id: typeof author.id === "string" ? author.id : "" }))
                : [],
            dependencies: stringArray(entry.dependencies),
            hasPatches: entry.hasPatches === true,
            hasCommands: entry.hasCommands === true,
            required: entry.required === true,
            enabledByDefault: entry.enabledByDefault === true,
            target: typeof entry.target === "string" ? entry.target : undefined,
            filePath: entry.filePath as string,
            indexed: true
        }));
}

function loadReadmes(): Record<string, string> {
    if (readmeCache) return readmeCache;

    readmeCache = {};
    const path = "web/public/readmes.json";
    if (!existsSync(resolveRepoPath(path))) return readmeCache;

    try {
        const parsed: unknown = JSON.parse(readRepoFile(path, 4_000_000).text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return readmeCache;

        for (const [name, readme] of Object.entries(parsed)) {
            if (typeof readme === "string") readmeCache[name] = readme;
        }
    } catch {
        // a broken readme cache is not fatal: plugin READMEs are also read from disk
    }

    return readmeCache;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Every plugin entry point, using the same rules as scripts/generatePluginList.ts: a directory
 * with an index file is one plugin, a directory without one is a group of single-file plugins.
 */
function collectPluginEntryPaths(): string[] {
    const entries: string[] = [];

    const walk = (directory: string) => {
        let dirents;
        try {
            dirents = readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        const visible = dirents.filter(dirent => !dirent.name.startsWith("_") && !dirent.name.startsWith("."));
        const indexEntry = visible.find(dirent => !dirent.isDirectory() && /^index\.tsx?$/.test(dirent.name));

        if (indexEntry) {
            entries.push(join(directory, indexEntry.name));
            return;
        }

        for (const dirent of visible.sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(directory, dirent.name);
            if (dirent.isDirectory()) walk(full);
            else if (/\.tsx?$/.test(dirent.name)) entries.push(full);
        }
    };

    for (const start of ["src/plugins", "src/plugins/_core"]) {
        const absolute = join(repoRoot(), start);
        if (existsSync(absolute)) walk(absolute);
    }

    return entries;
}

function readFallbackRecord(absoluteEntry: string): PluginRecord {
    const entryPath = repoPath(absoluteEntry);
    const filePath = entryPath
        .replace(/^src\/plugins\//, "")
        .replace(/\/index\.tsx?$/, "");

    const body = pluginObjectBody(readRepoFile(entryPath, 300_000).text);
    const fallbackName = filePath.split("/").pop()!.replace(/\.tsx?$/, "");

    const read = (property: string) => (body === undefined ? undefined : readStringProperty(body, property));
    const hasArray = (property: string) => body !== undefined && new RegExp(`(?:^|\\n)\\s*${property}:\\s*\\[`).test(body);
    const isTrue = (property: string) => body !== undefined && new RegExp(`(?:^|\\n)\\s*${property}:\\s*true`).test(body);

    return {
        name: read("name") ?? fallbackName,
        description: read("description") ?? "",
        tags: body === undefined ? [] : parseStringArray(body, "tags"),
        searchTerms: body === undefined ? [] : parseStringArray(body, "searchTerms"),
        authors: [],
        dependencies: [],
        hasPatches: hasArray("patches"),
        hasCommands: hasArray("commands"),
        required: isTrue("required"),
        enabledByDefault: isTrue("enabledByDefault"),
        filePath,
        indexed: false
    };
}

/** The object literal passed to `definePlugin`, following `definePlugin(SomePlugin)` to its const. */
function pluginObjectBody(source: string): string | undefined {
    const call = /definePlugin\s*(?:<[^>]*>)?\(/.exec(source);
    if (!call) return undefined;

    const argumentStart = call.index + call[0].length;
    const brace = source.indexOf("{", argumentStart);
    if (brace === -1) return undefined;

    const beforeBrace = source.slice(argumentStart, brace).trim();
    if (beforeBrace === "") return extractBalanced(source, brace);

    const identifier = /^([A-Za-z_$][\w$]*)\s*(?:as\s+(?:any|const)[^,)]*|satisfies\s+[^,)]*)?$/.exec(beforeBrace);
    if (!identifier) return undefined;

    const declaration = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(identifier[1])}\\s*(?::[^=]+)?=\\s*\\{`).exec(source);
    if (!declaration) return undefined;

    return extractBalanced(source, declaration.index + declaration[0].lastIndexOf("{"));
}

// ---- source parsing ----

/**
 * Returns the text between a bracket and its partner, skipping strings, comments, regex literals
 * and nesting. Patch definitions are full of regexes, so a plain brace count would miss the end.
 */
function extractBalanced(source: string, openIndex: number): string | undefined {
    const open = source[openIndex];
    const close = open === "{" ? "}" : open === "[" ? "]" : open === "(" ? ")" : undefined;
    if (!close) return undefined;

    let depth = 0;
    let quote: string | undefined;
    let previous = "";

    for (let index = openIndex; index < source.length; index++) {
        const char = source[index];

        if (quote) {
            if (char === "\\") {
                index++;
                continue;
            }
            if (char === quote) quote = undefined;
            continue;
        }

        if (char === "\"" || char === "'" || char === "`") {
            quote = char;
            previous = char;
            continue;
        }

        if (char === "/" && source[index + 1] === "/") {
            const newline = source.indexOf("\n", index);
            index = newline === -1 ? source.length : newline;
            previous = "\n";
            continue;
        }

        if (char === "/" && source[index + 1] === "*") {
            const end = source.indexOf("*/", index + 2);
            index = end === -1 ? source.length : end + 1;
            continue;
        }

        if (char === "/" && canStartRegex(previous)) {
            const end = skipRegexLiteral(source, index);
            if (end !== -1) {
                index = end;
                previous = "/";
                continue;
            }
        }

        if (char === open) {
            depth++;
        } else if (char === close && --depth === 0) {
            return source.slice(openIndex + 1, index);
        }

        if (!/\s/.test(char)) previous = char;
    }

    return undefined;
}

function canStartRegex(previous: string): boolean {
    return previous === "" || "(,=:[!&|?{};+-*%~^<>".includes(previous);
}

function skipRegexLiteral(source: string, start: number): number {
    let inCharacterClass = false;

    for (let index = start + 1; index < source.length; index++) {
        const char = source[index];

        if (char === "\\") {
            index++;
            continue;
        }

        if (char === "\n") return -1;
        if (char === "[") inCharacterClass = true;
        else if (char === "]") inCharacterClass = false;
        else if (char === "/" && !inCharacterClass) return index;
    }

    return -1;
}

/** Top-level `key: { ... }` members of an object body. */
function objectProperties(body: string): { key: string; body: string; }[] {
    const properties: { key: string; body: string; }[] = [];
    let cursor = 0;

    while (cursor < body.length) {
        const match = /([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(body.slice(cursor));
        if (!match) break;

        const braceIndex = cursor + match.index + match[0].lastIndexOf("{");
        const inner = extractBalanced(body, braceIndex);
        if (inner === undefined) break;

        properties.push({ key: match[1], body: inner });
        cursor = braceIndex + inner.length + 2;
    }

    return properties;
}

/** Top-level `{ ... }` members of an array body. */
function arrayObjects(body: string): string[] {
    const objects: string[] = [];
    let cursor = 0;

    while (cursor < body.length) {
        const braceIndex = body.indexOf("{", cursor);
        if (braceIndex === -1) break;

        const inner = extractBalanced(body, braceIndex);
        if (inner === undefined) break;

        objects.push(inner);
        cursor = braceIndex + inner.length + 2;
    }

    return objects;
}

export function parseSettings(source: string): PluginSetting[] {
    const marker = source.indexOf("definePluginSettings(");
    if (marker === -1) return [];

    const brace = source.indexOf("{", marker);
    if (brace === -1) return [];

    const body = extractBalanced(source, brace);
    if (!body) return [];

    return objectProperties(body).map(({ key, body: value }) => ({
        key,
        type: /type:\s*(?:OptionType\.)?([A-Za-z_$][\w$]*)/.exec(value)?.[1],
        description: readStringProperty(value, "description"),
        default: /(?:^|[\s,{])default:\s*([^,\n}]+)/.exec(value)?.[1]?.trim(),
        restartNeeded: /restartNeeded:\s*true/.test(value)
    }));
}

export function parsePermissions(source: string): PluginPermission[] {
    const marker = /permissions:\s*\[/.exec(source);
    if (!marker) return [];

    const bracket = source.indexOf("[", marker.index);
    const body = extractBalanced(source, bracket);
    if (!body) return [];

    return arrayObjects(body)
        .map(entry => ({
            id: readStringProperty(entry, "id") ?? "",
            title: readStringProperty(entry, "title"),
            risk: readStringProperty(entry, "risk")
        }))
        .filter(permission => permission.id !== "");
}

export function collectImports(source: string): string[] {
    const modules = new Set<string>();

    for (const match of source.matchAll(/from\s+["'](@(?:api|utils|webpack|components|shared)(?:\/[^"']*)?)["']/g)) {
        modules.add(match[1]);
    }

    return [...modules];
}

function readStringProperty(source: string, property: string): string | undefined {
    const pattern = new RegExp(
        `${property}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|\`([^\`]*)\`)`
    );
    const match = pattern.exec(source);
    if (!match) return undefined;

    return (match[1] ?? match[2] ?? match[3])?.replace(/\\(["'`\\])/g, "$1");
}

function parseStringArray(source: string, property: string): string[] {
    const pattern = new RegExp(`${property}\\s*:\\s*\\[([^\\]]*)\\]`);
    const match = pattern.exec(source);
    if (!match) return [];

    return [...match[1].matchAll(/["']([^"']+)["']/g)].map(entry => entry[1]);
}

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { clip, formatBytes } from "../format.js";
import { RepoError, readRepoFile } from "../repo.js";
import { searchSource } from "../search.js";

export function registerSourceTools(server: McpServer) {
    server.registerTool(
        "limey_read_file",
        {
            title: "Read a Limey V1 file",
            description: `Read a text file from the Limey V1 checkout by repository-relative path.

Use limey_get_plugin or limey_search_source to find paths. The response starts with the path and line range, then the file content.

Examples:
  - {"path": "src/plugins/memberCount/index.ts", "line_start": 1, "line_end": 80}
  - {"path": "AGENTS.md"}`,
            inputSchema: z.strictObject({
                path: z.string().min(1).max(400)
                    .describe("Repository-relative path, e.g. 'src/api/Settings.ts'"),
                line_start: z.number().int().min(1).optional()
                    .describe("First line to return (1-based)"),
                line_end: z.number().int().min(1).optional()
                    .describe("Last line to return (inclusive)"),
                max_chars: z.number().int().min(500).max(60_000).default(20_000)
                    .describe("Maximum characters of file content to return")
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ path, line_start, line_end, max_chars }) => {
            const file = readRepoFile(path, 1_500_000);
            const lines = file.text.split("\n");

            const start = line_start ?? 1;
            const end = line_end ?? lines.length;

            if (start > lines.length) {
                throw new RepoError(`line_start ${start} is past the end of ${file.path}, which has ${lines.length} lines.`);
            }
            if (end < start) {
                throw new RepoError(`line_end ${end} is before line_start ${start}.`);
            }

            const selected = lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
            const clipped = clip(selected, max_chars);

            const header = `# ${file.path} (lines ${start}-${Math.min(end, lines.length)} of ${lines.length}, ${formatBytes(file.bytes)}${file.truncated ? ", file cut at 1.5 MB" : ""})`;

            return { content: [{ type: "text", text: `${header}\n\n${clipped.text}` }] };
        }
    );

    server.registerTool(
        "limey_search_source",
        {
            title: "Search Limey V1 source",
            description: `Search the Limey V1 checkout for text or a regular expression and return matching lines with their file and line number.

Searches src/ by default; pass path to search a plugin folder, docs or the whole repository. Use this before reading files when you do not know where something lives.

Examples:
  - {"query": "proxyLazy"} finds every use of the lazy helper
  - {"query": "definePluginSettings", "path": "src/plugins/betterForums", "context_lines": 1}
  - {"query": "findByPropsLazy", "path": "src/plugins", "include": "**/*.{ts,tsx}", "max_results": 100}`,
            inputSchema: z.strictObject({
                query: z.string().min(1).max(500)
                    .describe("Text to find, or a regular expression when regex=true"),
                regex: z.boolean().default(false)
                    .describe("Treat query as a JavaScript regular expression"),
                case_sensitive: z.boolean().default(false)
                    .describe("Match case sensitively"),
                path: z.string().min(1).max(400).default("src")
                    .describe("Repository-relative file or directory to search"),
                include: z.string().min(1).max(200).default("**/*")
                    .describe("Glob the repo-relative file path must match, e.g. '**/*.tsx' or 'src/plugins/**'"),
                context_lines: z.number().int().min(0).max(3).default(0)
                    .describe("Lines of context to include around each match"),
                max_results: z.number().int().min(1).max(200).default(50)
                    .describe("Maximum number of matching lines to return"),
                response_format: z.enum(["markdown", "json"]).default("markdown")
                    .describe("'markdown' for readable text, 'json' for structured data")
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        },
        async ({ query, regex, case_sensitive, path, include, context_lines, max_results, response_format }) => {
            const result = searchSource({
                query,
                regex,
                caseSensitive: case_sensitive,
                path,
                include,
                maxResults: max_results,
                contextLines: context_lines
            });

            if (response_format === "json") {
                const page = {
                    query,
                    path,
                    total: result.matches.length,
                    files_scanned: result.filesScanned,
                    truncated: result.truncated,
                    matches: result.matches
                };

                return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }], structuredContent: page };
            }

            const byFile = new Map<string, typeof result.matches>();
            for (const match of result.matches) {
                const existing = byFile.get(match.path) ?? [];
                existing.push(match);
                byFile.set(match.path, existing);
            }

            const lines = [
                `# ${result.matches.length}${result.truncated ? "+" : ""} matches for ${regex ? `/${query}/` : `"${query}"`} in ${path}`,
                `Scanned ${result.filesScanned} files.`,
                ""
            ];

            if (result.matches.length === 0) {
                lines.push("No matches. Try a shorter query, regex=true, or a wider path/include.");
            }

            for (const [file, matches] of byFile) {
                lines.push(`## ${file}`);
                for (const match of matches) {
                    lines.push(...(match.context
                        ? ["```", ...match.context, "```", `  line ${match.line}`]
                        : [`- ${match.line}: ${match.text.trim()}`]));
                }
                lines.push("");
            }

            if (result.truncated) {
                lines.push(`Stopped at ${max_results} matches. Narrow the query or raise max_results for more.`);
            }

            const clipped = clip(lines.join("\n"));
            return { content: [{ type: "text", text: clipped.text }] };
        }
    );
}

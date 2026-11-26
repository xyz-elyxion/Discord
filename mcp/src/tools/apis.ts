import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { findApiModule, getApiModules } from "../apis.js";
import { clip, paginate } from "../format.js";
import { readRepoFile } from "../repo.js";

const responseFormat = z.enum(["markdown", "json"]).default("markdown")
    .describe("'markdown' for readable text, 'json' for structured data");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function exportNames(names: string[], limit = 12): string {
    if (names.length <= limit) return names.join(", ");
    return `${names.slice(0, limit).join(", ")} … (+${names.length - limit})`;
}

export function registerApiTools(server: McpServer) {
    server.registerTool(
        "limey_list_apis",
        {
            title: "List Limey V1 plugin APIs",
            description: `List the modules under src/api that plugins can import from @api/*, with the symbols each one exports.

Use this when writing a plugin and you need to know which APIs exist, then limey_get_api for the exports and JSDoc of one module.

Examples:
  - {"query": "settings"} finds API modules about settings
  - {"limit": 100} lists every API module`,
            inputSchema: z.strictObject({
                query: z.string().min(1).max(100).optional()
                    .describe("Case-insensitive text matched against module names, paths and export names"),
                limit: z.number().int().min(1).max(100).default(50)
                    .describe("Maximum number of API modules to return"),
                offset: z.number().int().min(0).default(0)
                    .describe("Number of modules to skip, for pagination"),
                response_format: responseFormat
            }),
            annotations: readOnly
        },
        async ({ query, limit, offset, response_format }) => {
            const needle = query?.trim().toLowerCase();

            const matching = getApiModules().filter(module => {
                if (!needle) return true;
                return [module.name, module.path, ...module.exports.map(entry => entry.name)]
                    .join(" ").toLowerCase().includes(needle);
            });

            const { page, text } = paginate(matching.slice(offset, offset + limit), items => {
                const nextOffset = offset + items.length;
                const hasMore = matching.length > nextOffset;

                const page = {
                    total: matching.length,
                    count: items.length,
                    offset,
                    modules: items,
                    has_more: hasMore,
                    ...(hasMore ? { next_offset: nextOffset } : {})
                };

                if (response_format === "json") return { page, text: JSON.stringify(page, null, 2) };

                const lines = [
                    `# Limey V1 plugin APIs${needle ? ` matching "${needle}"` : ""}`,
                    `Showing ${items.length} of ${matching.length} modules.`,
                    ""
                ];

                if (items.length === 0) lines.push("No API module matches. Try a shorter query.");

                for (const module of items) {
                    lines.push(`## ${module.name} (${module.path})`);
                    lines.push(module.exports.length
                        ? exportNames(module.exports.map(entry => entry.name))
                        : "No exports found.");
                    lines.push("");
                }

                if (hasMore) lines.push(`More results: call again with offset=${nextOffset}.`);

                return { page, text: lines.join("\n") };
            });

            return response_format === "json"
                ? { content: [{ type: "text", text }], structuredContent: page }
                : { content: [{ type: "text", text }] };
        }
    );

    server.registerTool(
        "limey_get_api",
        {
            title: "Get a Limey V1 plugin API",
            description: `Show one src/api module: every export with its kind and JSDoc summary, and optionally the full source.

Use limey_list_apis to find module names. Plugin code imports these as "@api/Settings", "@api/Commands", and so on.

Examples:
  - {"module": "Settings"} explains definePluginSettings and the related types
  - {"module": "DataStore", "include_source": true}`,
            inputSchema: z.strictObject({
                module: z.string().min(1).max(120)
                    .describe("API module name or path, e.g. 'Settings', 'DataStore' or 'src/api/Settings.ts'"),
                include_source: z.boolean().default(false)
                    .describe("Include the module source code"),
                response_format: responseFormat
            }),
            annotations: readOnly
        },
        async ({ module: requested, include_source, response_format }) => {
            const module = findApiModule(requested);
            const source = include_source ? clip(readRepoFile(module.path, 400_000).text, 18_000) : undefined;

            const page = {
                ...module,
                ...(source ? { source: source.text } : {})
            };

            if (response_format === "json") {
                return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }], structuredContent: page };
            }

            const lines = [
                `# ${module.name}`,
                `Path: ${module.path}`,
                "",
                `## Exports (${module.exports.length})`
            ];

            if (module.exports.length === 0) lines.push("No exports found.");

            for (const entry of module.exports) {
                lines.push(`- \`${entry.name}\` (${entry.kind})${entry.summary ? ` — ${entry.summary}` : ""}`);
            }

            if (source) {
                lines.push("", "## Source", source.text);
            }

            return { content: [{ type: "text", text: lines.join("\n") }] };
        }
    );
}

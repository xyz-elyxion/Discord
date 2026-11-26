import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { CHARACTER_LIMIT, clip, formatBytes, paginate } from "../format.js";
import { findPlugin, getPluginDetails, getPlugins, PluginRecord } from "../plugins.js";

const responseFormat = z.enum(["markdown", "json"]).default("markdown")
    .describe("'markdown' for readable text, 'json' for structured data");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function pluginSummaryLines(plugin: PluginRecord): string[] {
    const flags = [
        plugin.hasPatches && "patches",
        plugin.hasCommands && "commands",
        plugin.enabledByDefault && "enabled by default",
        plugin.required && "required",
        plugin.target && `target: ${plugin.target}`
    ].filter((flag): flag is string => typeof flag === "string");

    const meta: string[] = [];
    if (plugin.tags.length) meta.push(`tags: ${plugin.tags.join(", ")}`);
    if (plugin.authors.length) meta.push(`authors: ${plugin.authors.map(author => author.name).join(", ")}`);

    return [
        `## ${plugin.name}`,
        plugin.description || "(no description in the plugin index)",
        ...(meta.length ? [meta.join(" · ")] : []),
        `path: src/plugins/${plugin.filePath}${flags.length ? ` · ${flags.join(", ")}` : ""}${plugin.indexed ? "" : " · missing from web/public/plugins.json"}`
    ];
}

export function registerPluginTools(server: McpServer) {
    server.registerTool(
        "limey_list_plugins",
        {
            title: "List Limey V1 plugins",
            description: `List the plugins that ship with the Limey V1 Discord client mod, with description, tags, authors and source path.

Use this to find a plugin by name or by what it does. Use limey_get_plugin for one plugin's README, settings, permissions and files.

The catalogue is web/public/plugins.json, plus any plugin directory missing from it (shown as "missing from web/public/plugins.json").

Examples:
  - {"query": "forum"} finds plugins that mention forums
  - {"tag": "Utility", "limit": 50} lists utility plugins`,
            inputSchema: z.strictObject({
                query: z.string().min(1).max(200).optional()
                    .describe("Case-insensitive text matched against plugin names, descriptions, tags, search terms and authors"),
                tag: z.string().min(1).max(60).optional()
                    .describe("Only plugins with this exact tag, e.g. 'Utility'"),
                target: z.string().min(1).max(40).optional()
                    .describe("Only plugins for this build target, e.g. 'discordDesktop' or 'web'"),
                limit: z.number().int().min(1).max(100).default(25)
                    .describe("Maximum number of plugins to return"),
                offset: z.number().int().min(0).default(0)
                    .describe("Number of matching plugins to skip, for pagination"),
                response_format: responseFormat
            }),
            annotations: readOnly
        },
        async ({ query, tag, target, limit, offset, response_format }) => {
            const needle = query?.trim().toLowerCase();
            const wantedTag = tag?.trim().toLowerCase();
            const wantedTarget = target?.trim();

            const matching = getPlugins().filter(plugin => {
                if (needle) {
                    const haystack = [
                        plugin.name,
                        plugin.description,
                        plugin.filePath,
                        ...plugin.tags,
                        ...plugin.searchTerms,
                        ...plugin.authors.map(author => author.name)
                    ].join(" ").toLowerCase();

                    if (!haystack.includes(needle)) return false;
                }

                if (wantedTag && !plugin.tags.some(pluginTag => pluginTag.toLowerCase() === wantedTag)) return false;
                if (wantedTarget && plugin.target !== wantedTarget) return false;

                return true;
            });

            const pageItems = matching.slice(offset, offset + limit);

            const { page, text } = paginate(pageItems, items => {
                const nextOffset = offset + items.length;
                const hasMore = matching.length > nextOffset;

                const page = {
                    total: matching.length,
                    count: items.length,
                    offset,
                    plugins: items,
                    has_more: hasMore,
                    ...(hasMore ? { next_offset: nextOffset } : {})
                };

                if (response_format === "json") return { page, text: JSON.stringify(page, null, 2) };

                const heading = needle || wantedTag || wantedTarget
                    ? `# Limey V1 plugins matching ${[needle && `"${needle}"`, wantedTag && `tag ${wantedTag}`, wantedTarget && `target ${wantedTarget}`].filter(Boolean).join(" + ")}`
                    : "# Limey V1 plugins";

                const lines = [heading, `Showing ${items.length} of ${matching.length}.`, ""];

                if (items.length === 0) {
                    lines.push("No plugin matches. Try a shorter query, or drop the tag/target filter.");
                }

                for (const plugin of items) lines.push(...pluginSummaryLines(plugin), "");

                if (hasMore) lines.push(`More results: call again with offset=${nextOffset}.`);

                return { page, text: lines.join("\n") };
            });

            return response_format === "json"
                ? { content: [{ type: "text", text }], structuredContent: page }
                : { content: [{ type: "text", text }] };
        }
    );

    server.registerTool(
        "limey_get_plugin",
        {
            title: "Get a Limey V1 plugin",
            description: `Everything about one Limey V1 plugin: its catalogue entry, README, files, settings options, declared permissions and the plugin APIs it imports.

Use limey_list_plugins first when you only know roughly what the plugin does. Use limey_read_file with one of the returned file paths to read the source.

Examples:
  - {"plugin": "BetterForums"} returns the forum plugin with its README and settings
  - {"plugin": "memberCount", "include_readme": false} skips the README`,
            inputSchema: z.strictObject({
                plugin: z.string().min(1).max(120)
                    .describe("Plugin name (case-insensitive) or plugin folder, e.g. 'MemberCount' or 'hideServers'"),
                include_readme: z.boolean().default(true)
                    .describe("Include the plugin README when one exists"),
                response_format: responseFormat
            }),
            annotations: readOnly
        },
        async ({ plugin, include_readme, response_format }) => {
            const details = getPluginDetails(findPlugin(plugin));
            const { plugin: record, location, permissions, settings, imports } = details;

            const readme = include_readme && details.readme
                ? clip(details.readme, 18_000)
                : undefined;

            const page = {
                plugin: record,
                location,
                settings,
                permissions,
                imports,
                ...(readme ? { readme: readme.text, readme_truncated: readme.truncated } : {})
            };

            if (response_format === "json") {
                const text = clip(JSON.stringify(page, null, 2)).text;
                return { content: [{ type: "text", text }], structuredContent: page };
            }

            const flags = [
                record.hasPatches && "patches",
                record.hasCommands && "commands",
                record.enabledByDefault && "enabled by default",
                record.required && "required",
                record.target && `target: ${record.target}`
            ].filter((flag): flag is string => typeof flag === "string");

            const lines = [
                `# ${record.name}`,
                record.description || "(no description in the plugin index)",
                "",
                `- Path: src/plugins/${record.filePath}`,
                `- Entry: ${location.entry}`,
                `- Authors: ${record.authors.length ? record.authors.map(author => `${author.name} (${author.id})`).join(", ") : "unknown"}`,
                `- Tags: ${record.tags.length ? record.tags.join(", ") : "none"}`,
                `- Flags: ${flags.length ? flags.join(", ") : "none"}`,
                `- Plugin index: ${record.indexed ? "indexed" : "missing from web/public/plugins.json, run pnpm generatePluginJson"}`,
                ""
            ];

            lines.push(`## Settings (${settings.length})`);
            if (settings.length === 0) lines.push("This plugin defines no settings.");
            for (const setting of settings) {
                const meta = [setting.type, setting.default !== undefined && `default: ${setting.default}`, setting.restartNeeded && "restart needed"]
                    .filter((part): part is string => typeof part === "string");

                lines.push(`- \`${setting.key}\`${meta.length ? ` (${meta.join(", ")})` : ""}${setting.description ? `: ${setting.description}` : ""}`);
            }
            lines.push("");

            if (permissions.length) {
                lines.push(`## Permissions (${permissions.length})`);
                for (const permission of permissions) {
                    lines.push(`- \`${permission.id}\`${permission.title ? `: ${permission.title}` : ""}${permission.risk ? ` — risk: ${permission.risk}` : ""}`);
                }
                lines.push("");
            }

            lines.push(`## Files (${location.files.length})`);
            for (const file of location.files.slice(0, 40)) {
                lines.push(`- ${file.path} (${formatBytes(file.bytes)})`);
            }
            if (location.files.length > 40) lines.push(`- … ${location.files.length - 40} more`);
            lines.push("");

            if (imports.length) {
                lines.push("## Plugin APIs used");
                lines.push(imports.join(", "), "");
            }

            if (readme) {
                // Give the README whatever is left of the response budget, not a fixed slice.
                const budget = Math.max(1_500, CHARACTER_LIMIT - lines.join("\n").length - 200);
                lines.push("## README", clip(readme.text, budget).text);
            }

            return { content: [{ type: "text", text: clip(lines.join("\n")).text }] };
        }
    );
}

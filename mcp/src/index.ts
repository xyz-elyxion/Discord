#!/usr/bin/env node
/**
 * Limey V1 MCP server.
 *
 * Gives an AI agent read access to a Limey V1 checkout: the plugin catalogue, plugin READMEs and
 * settings, the plugin API index, and any source file. Runs over stdio, so the host launches it as
 * a subprocess; nothing is written to the client and no network requests are made.
 */

import { McpServer, ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { getPluginReadmeByName, getPlugins } from "./plugins.js";
import { readRepoFile, repoRoot } from "./repo.js";
import { registerApiTools } from "./tools/apis.js";
import { registerPluginTools } from "./tools/plugins.js";
import { registerSourceTools } from "./tools/source.js";

function registerResources(server: McpServer) {
    server.registerResource(
        "limey-plugins",
        "limey://plugins",
        {
            title: "Limey V1 plugin catalogue",
            description: "Every plugin in the checkout with its description, tags, authors and source path",
            mimeType: "application/json"
        },
        async uri => ({
            contents: [{
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify(getPlugins(), null, 2)
            }]
        })
    );

    server.registerResource(
        "limey-plugin-readme",
        new ResourceTemplate("limey://plugins/{plugin}/readme", { list: undefined }),
        {
            title: "Plugin README",
            description: "The README.md of one plugin, addressed by plugin name",
            mimeType: "text/markdown"
        },
        async (uri, { plugin }) => {
            const readme = getPluginReadmeByName(decodeURIComponent(String(plugin)));

            if (!readme) throw new ResourceNotFoundError(uri.href);

            return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: readme }] };
        }
    );

    server.registerResource(
        "limey-agent-guide",
        "limey://guide/agents",
        {
            title: "Limey V1 working notes for agents",
            description: "AGENTS.md: repository map, commands, plugin conventions, code style and traps",
            mimeType: "text/markdown"
        },
        async uri => ({
            contents: [{ uri: uri.href, mimeType: "text/markdown", text: readRepoFile("AGENTS.md", 200_000).text }]
        })
    );
}

function createServer(): McpServer {
    const server = new McpServer({ name: "limey-v1-mcp-server", version: "1.0.0" });

    registerPluginTools(server);
    registerApiTools(server);
    registerSourceTools(server);
    registerResources(server);

    return server;
}

// Resolve the checkout up front so a misconfigured LIMEY_V1_ROOT fails loudly at startup instead of
// on the first tool call. stdout belongs to the protocol, so this goes to stderr.
try {
    const root = repoRoot();
    const plugins = getPlugins();
    console.error(`limey-v1-mcp-server: serving ${root} (${plugins.length} plugins) over stdio`);
} catch (error) {
    console.error(`limey-v1-mcp-server: ${(error as Error).message}`);
    process.exit(1);
}

serveStdio(createServer);

/**
 * Self-check: starts the built server over stdio, calls every tool and resource the way a client
 * would, and exits non-zero on any failure.
 *
 * Run with: pnpm build && pnpm smoke
 */

import { strict as assert } from "node:assert";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "limey-v1-smoke", version: "1.0.0" });

await client.connect(new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...getDefaultEnvironment(), LIMEY_V1_ROOT: resolve(import.meta.dirname, "..", "..") }
}));

try {
    const { tools } = await client.listTools();
    assert.deepEqual(
        tools.map(tool => tool.name).sort(),
        ["limey_get_api", "limey_get_plugin", "limey_list_apis", "limey_list_plugins", "limey_read_file", "limey_search_source"],
        "unexpected tool list"
    );

    const listed = await client.callTool({
        name: "limey_list_plugins",
        arguments: { query: "forum", response_format: "json" }
    });
    assert.ok(!listed.isError, `list_plugins failed: ${JSON.stringify(listed.content)}`);
    const catalogue = listed.structuredContent as { total: number; plugins: { name: string }[]; };
    assert.ok(catalogue.total > 0, "expected at least one forum-related plugin");
    assert.ok(catalogue.plugins.some(plugin => plugin.name === "BetterForums"), "expected BetterForums in the forum query");

    const plugin = await client.callTool({ name: "limey_get_plugin", arguments: { plugin: "BetterForums" } });
    assert.ok(!plugin.isError, `get_plugin failed: ${JSON.stringify(plugin.content)}`);
    const pluginText = (plugin.content[0] as { text: string; }).text;
    assert.match(pluginText, /## Settings \(\d+\)/, "expected a settings section");
    assert.match(pluginText, /## Files \(\d+\)/, "expected a file list");

    const file = await client.callTool({
        name: "limey_read_file",
        arguments: { path: "src/api/Settings.ts", line_start: 1, line_end: 12 }
    });
    assert.ok(!file.isError, `read_file failed: ${JSON.stringify(file.content)}`);
    assert.match((file.content[0] as { text: string; }).text, /src\/api\/Settings\.ts \(lines 1-12/);

    const search = await client.callTool({
        name: "limey_search_source",
        arguments: { query: "proxyLazy", path: "src/utils", max_results: 5, response_format: "json" }
    });
    assert.ok(!search.isError, `search_source failed: ${JSON.stringify(search.content)}`);
    const searchPage = search.structuredContent as { total: number; matches: { path: string; line: number; }[]; };
    assert.ok(searchPage.total > 0, "expected proxyLazy matches in src/utils");
    assert.ok(searchPage.matches.every(match => match.path.startsWith("src/utils/")), "search escaped its path");

    const apis = await client.callTool({
        name: "limey_list_apis",
        arguments: { query: "settings", response_format: "json" }
    });
    assert.ok(!apis.isError, `list_apis failed: ${JSON.stringify(apis.content)}`);
    const apiPage = apis.structuredContent as { modules: { name: string; }[]; };
    assert.ok(apiPage.modules.some(module => module.name === "Settings"), "expected the Settings API module");

    const api = await client.callTool({ name: "limey_get_api", arguments: { module: "Settings" } });
    assert.ok(!api.isError, `get_api failed: ${JSON.stringify(api.content)}`);
    assert.match((api.content[0] as { text: string; }).text, /definePluginSettings/);

    const resources = await client.listResources();
    assert.ok(resources.resources.some(resource => resource.uri === "limey://plugins"), "expected the plugin catalogue resource");

    const readme = await client.readResource({ uri: "limey://plugins/BetterForums/readme" });
    assert.ok(readme.contents.length > 0, "expected a README resource");

    // Errors must come back as readable tool results, not protocol failures or crashes
    const unknownPlugin = await client.callTool({ name: "limey_get_plugin", arguments: { plugin: "definitely-not-a-plugin" } });
    assert.equal(unknownPlugin.isError, true, "an unknown plugin should be a tool error");

    const escapedPath = await client.callTool({ name: "limey_read_file", arguments: { path: "../../etc/passwd" } });
    assert.equal(escapedPath.isError, true, "a path outside the checkout should be rejected");

    const badRegex = await client.callTool({ name: "limey_search_source", arguments: { query: "([", regex: true } });
    assert.equal(badRegex.isError, true, "an invalid regex should be a tool error");

    console.error("Smoke test passed: 6 tools, 3 resources, 3 rejected inputs");
} finally {
    await client.close();
}

# limey-v1-mcp-server

An MCP (Model Context Protocol) server that lets an AI agent work with **Limey V1**, the Discord
client mod in this repository. It reads the checkout it is pointed at and exposes the plugin
catalogue, each plugin's README / settings / permissions, the `src/api` plugin API index, and any
source file.

Everything is read-only: no tool writes files, changes settings or talks to a running Discord
client. The server runs over stdio, so the host starts it as a subprocess.

## Requirements

- Node.js 20.3 or newer
- A Limey V1 checkout (this repository)

## Install and build

```bash
cd mcp
pnpm install          # this folder is its own pnpm workspace with its own lockfile
pnpm build            # tsc -> dist/
```

`pnpm install` needs to run inside `mcp/`; the folder has its own `pnpm-workspace.yaml` so pnpm
does not resolve through the repository root. If pnpm still installs the root workspace, use
`pnpm install --ignore-workspace`.

## Run it

```bash
pnpm start                      # node dist/index.js, serves stdio
pnpm dev                        # same, straight from src with tsx
node dist/index.js              # e.g. from a host that launches the server itself
```

The server finds the repository it was built in. To serve a different checkout, set
`LIMEY_V1_ROOT` to that repository root (the folder containing `src/plugins` and `src/api`).

## Configure a client

**Claude Desktop / Cursor / other JSON-configured hosts**

```json
{
  "mcpServers": {
    "limey-v1": {
      "command": "node",
      "args": ["/absolute/path/to/Discord/mcp/dist/index.js"],
      "env": {
        "LIMEY_V1_ROOT": "/absolute/path/to/Discord"
      }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add limey-v1 -- node /absolute/path/to/Discord/mcp/dist/index.js
```

## Tools

| Tool | What it does |
| --- | --- |
| `limey_list_plugins` | Browse the plugin catalogue by text, tag or build target, with pagination (`limit` / `offset`). Each row has the description, tags, authors and source path. |
| `limey_get_plugin` | One plugin: catalogue entry, README, file list, settings options with defaults, declared permissions, and the `@api` / `@webpack` modules it imports. |
| `limey_read_file` | Read any text file in the checkout by repository-relative path, with an optional line range. |
| `limey_search_source` | Search the checkout for text or a regular expression, scoped by directory and glob, returning file, line and optional context. |
| `limey_list_apis` | The `src/api` modules plugins can import, with the symbols each exports. |
| `limey_get_api` | One API module: every export with its kind and JSDoc summary, optionally with the source. |

Every data tool accepts `response_format: "markdown" | "json"` (except `limey_read_file`, which
returns file content) and keeps responses under 25,000 characters by returning fewer items.

## Resources

| URI | Contents |
| --- | --- |
| `limey://plugins` | The whole plugin catalogue as JSON |
| `limey://plugins/{name}/readme` | One plugin's README |
| `limey://guide/agents` | `AGENTS.md`, the repository's working notes for agents |

## Where the data comes from

- **Plugin catalogue**: `web/public/plugins.json`, plus any plugin directory missing from it, which
  is labelled *missing from web/public/plugins.json*. Regenerate the index with
  `pnpm generatePluginJson` after adding or renaming plugins.
- **READMEs**: `web/public/readmes.json`, falling back to the plugin's `README.md` on disk.
- **Settings, permissions, imports**: parsed from the plugin's TypeScript source, so they match the
  code rather than the index.
- **API index**: `src/api`, with JSDoc comments attached to each export.

## Development

```bash
pnpm build && pnpm smoke     # starts dist/index.js, calls every tool, exits non-zero on failure
```

The server intentionally has no tool that runs commands or edits files; keep it that way unless the
MCP is meant to modify a client installation.

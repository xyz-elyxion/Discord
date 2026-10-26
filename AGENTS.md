# Agent guide

Working notes for coding agents in this repo. `README.md` explains the product; this file
explains the codebase, how to verify a change, and where the traps are.

## Rules

- **Never open an issue or a pull request.** Work happens in the checkout: edit files, run
  checks, and stop. The user makes commits and pushes, or asks you to.
- **Only commit or push when asked.** When asked, stage just the files for that change and
  keep the message in repo style (imperative subject, body explaining *why* — see `git log`).
- **No new dependencies** unless the task genuinely cannot be done with what is already
  installed. No CDN scripts, no vendored libraries "just in case".
- **Never hand-edit generated output**: `dist/` (the only tracked file there is the launcher
  shim), `packages/limeyV1-types/`, `web/public/plugins.json`, `web/public/readmes.json`.
  Rebuild or regenerate instead.
- **Never commit secrets.** `.env`, `bot/.env`, tokens, API keys and user data stay out of git
  and out of fixtures.
- **Do not rename load-bearing entry points**: root `server.js` (forwards to `web/server.js`),
  `dist/botOnly.js` (forwards to `bot/run.js`). Hosts hardcode these paths.
- **Say what you actually checked.** There is no Discord client in CI or in a sandbox, so most
  plugin behaviour cannot be clicked through. Verify with the static checks plus pure-logic
  harnesses, and name the runtime paths you left untested.

## Repository map

One repo, several independent projects. Each has its own `package.json`, lockfile, tsconfig
and (usually) eslint config; installing at the root does **not** install their dependencies.

| Path | Project | Install / verify |
| --- | --- | --- |
| `src/`, `browser/`, `packages/`, `installer/`, `scripts/`, root configs | **Limey V1 client mod** (Discord client mod; desktop, browser extension, userscript) | `pnpm install --frozen-lockfile`, `pnpm testTsc`, `pnpm lint` |
| `web/` + root `server.js` | **Web server**: site, admin panel, `/v1/*` APIs, single-file backends | `node --check <file>`; no build step |
| `bot/` | **Limebot**, the Discord bot (esbuild bundle, SQLite via kysely) | `cd bot && pnpm install --frozen-lockfile`, `pnpm testTypes`, `pnpm lint` |
| `desktop/` | Standalone Electron client (installer + portable) | `cd desktop && pnpm testTypes`, `pnpm lint` |
| `ghost-client/` | Ghost client overlay app (Windows) | `node --check` / its own scripts |
| `docs/` | Astro documentation site, built into `web/public/docs` | `cd docs && pnpm build` |
| `services/` | Small Go services (`cloud`, `sentinel-color-dirs`) | `go build ./...` in that service |
| `limebot-app/` | Electron wrapper volunteers use to run the bot | `pnpm check`, `pnpm build:linux` |
| `third_party/` | Vendored dependencies (imgui-go fork) | don't touch unless the task needs it |

## Commands

Node >= 22 (this repo's CI runs Node 24); `pnpm` is pinned via `packageManager` — use corepack
rather than installing a different major. Preserve `pnpm-lock.yaml`; never upgrade packages to
get an install working.

Root `package.json`:

| Command | What it does |
| --- | --- |
| `pnpm testTsc` | `tsc --noEmit` over `src/`, `browser/`, `scripts/` — the fastest real signal |
| `pnpm lint` | ESLint (style, import order, path aliases, licence headers) |
| `pnpm lint:fix` | auto-fix the fixable ones — run this before hand-fixing style |
| `pnpm lint-styles` | stylelint over `src/**/*.css` |
| `pnpm buildStandalone` | esbuild desktop/web bundle into `dist/` (also validates the plugin graph) |
| `pnpm buildWeb` | web/userscript/extension bundle, then zips the extension |
| `pnpm generatePluginJson` | walks `src/plugins`, fails on a malformed plugin, writes the plugin index |
| `pnpm test` | all of the above plus `generatePluginJson` — the full CI gate, slow |
| `pnpm watch` / `pnpm dev` | rebuild on change |

Pick the narrowest check that covers the edit: component/plugin logic → `pnpm testTsc` +
`pnpm lint`; new or renamed plugin → also `pnpm buildStandalone` and `pnpm generatePluginJson`;
`bot/` → its own `testTypes`/`lint`; anything in `browser/` or `userscript.meta.js` → `pnpm buildWeb`
(the installed userscript only changes after a rebuild).

## Writing a plugin

- One plugin per directory: `src/plugins/Name/index.ts` (aux files live beside it and are never
  imported by the loader) or a single `src/plugins/Name.ts`. The loader treats a directory with
  an `index.ts` as one plugin and recurses into directories that don't have one, so groups like
  `src/plugins/checkers/foo/` are fine. Folder name conventionally matches the plugin `name`.
- The module default-exports `definePlugin({...})` from `@utils/types` with `name`,
  `description`, `authors` (`Devs.*` from `@utils/constants`), `tags`, and `permissions` —
  permissions are optional in the type but inbuilt plugins declare every risky capability
  (UI patches, sending messages, network, local storage) with a plain-English `title`,
  `description` and `risk`.
- Settings come from `definePluginSettings()` in `@api/Settings`; they are persisted by plugin
  name, so use `migratePluginSettings("New", "Old")` when renaming.
- Slash commands are declared as a `commands: []` array using `@api/Commands`; to appear in
  Discord's own `/` menu use `ApplicationCommandInputType.BUILT_IN` and read values with
  `findOption`. Messages posted with `sendBotMessage` are private; only send real channel
  messages when the user opted in.
- Use the existing APIs under `src/api/` (Commands, MessageEvents, Settings, DataStore, Notices,
  ContextMenu, …) before reaching into `@webpack/common` internals, and never do raw DOM
  manipulation — patch the React component or module instead. Patches need a `find` string or
  RegExp specific enough not to hit unrelated modules.
- `start()`/`stop()` must be symmetric: clear timers, listeners, stores and patched state, or the
  plugin leaks across toggles.
- When a plugin needs network access, prefer a plain `fetch` to a public, CORS-enabled,
  well-known service. In the browser/userscript build the metadata block in
  `browser/userscript.meta.js` needs a matching `// @connect <host>` for calls that go through
  `GM_xmlhttpRequest`; plain `fetch` is instead subject to Discord's CSP. Either way, a userscript
  change only takes effect after `pnpm buildWeb` is reinstalled.

## Code style

Enforced by ESLint; let `pnpm lint:fix` do the mechanical parts and don't add suppressions to
get past a check.

- 4-space indent, double quotes, semicolons, trailing commas, `{ a: 1 }`, `if (!x)` with a space.
- Imports are sorted by `simple-import-sort`; unused imports are errors.
- Cross-folder imports use path aliases (`@api`, `@utils`, `@components`, `@webpack/common`,
  `@main`, `@shared`, `@plugins`) — relative paths are only for files inside the same plugin.
- `no-restricted-globals` bans the names `event` and `name`.
- Every file under `src/` starts with the GPL header in `scripts/header-new.txt` (plugin files
  use the longer `header-old.txt` form); copy an existing file and update the year, or lint fails.
- `strict` is on but `noImplicitAny` is off; match the surrounding typing discipline rather than
  sprinkling `any`.

## Traps

- `dist/` is build output. `pnpm build*` overwrites it; only the `botOnly.js` launcher shim is
  tracked, so a rebuild produces noise you should not commit.
- Discord internals change with every build. A patch that "had no effect" in the console
  (`Patch by X had no effect`) means the module's minified shape moved — fix the `find`, and use
  `fromBuild`/`toBuild` or `predicate` instead of deleting the patch.
- The bot's native modules (`better-sqlite3`, `sharp`, `@napi-rs/canvas`) are built for the host
  Node ABI; they are not interchangeable with Electron's. `bot/pnpm sql:up` needs the `sqlite3` CLI.
- Deleting or renaming files used by static hosts breaks deploys silently: WispByte runs
  `node dist/botOnly.js`, Render/Docker resolve `server.js` → `web/server.js`.
- `src/userplugins` is gitignored scratch space for local plugins; nothing there ships.
- `packages/discord-types` holds the Discord type definitions — extend it instead of casting to
  `any` when a store or module lacks a type.

## Definition of done

1. The narrowest relevant check passes (`pnpm testTsc`, `pnpm lint`, plus the build/`bot` check
   for the area you touched).
2. No generated files, lockfile churn or unrelated formatting in the diff.
3. You can state, in one sentence each, what changed, why, and what you could not verify.

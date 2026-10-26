# Limey V1

The cutest Discord client mod

![](https://github.com/user-attachments/assets/3fac98c0-c411-4d2a-97a3-13b7da8687a2)

## Repository layout

This is a monorepo — each top-level folder is its own project:

| Folder | Project |
| --- | --- |
| `src/`, `browser/`, `packages/`, `installer/`, `scripts/`, `patches/` + root configs | **Limey V1 client mod** (Discord client mod, browser extension + userscript) |
| `server.js` (shim) + `web/` | **Web server** — site, admin panel, `/v1/*` APIs, single-file backends (`server.js` at the root is kept for hosts that hardcode that start path) |
| `bot/` | **Discord bot** (Limebot) — starts via `dist/botOnly.js` → `bot/run.js` on single-file hosts like Wispbyte |
| `desktop/` | **Standalone Electron client** (packaged installer + portable builds) |
| `ghost-client/` | **Ghost client** overlay app (Windows) |
| `docs/` | **Astro docs site** (built output served from `web/public/docs`) |
| `services/` | Small **Go services**: `services/cloud` (settings-sync API), `services/sentinel-color-dirs` |
| `third_party/` | Vendored dependencies (imgui-go fork for the installer) |

Load-bearing static hosts (do not rename casually):
- Wispbyte always runs `node dist/botOnly.js` — the shim forwards to `bot/run.js`
- Render/Docker start commands resolve `server.js` → `web/server.js`

## Features

-   Easy to install
-   [100+ built in plugins](https://limey-discord.onrender.com/plugins)
-   Fairly lightweight despite the many inbuilt plugins
-   Excellent Browser Support: Run Limey V1 in your Browser via extension or UserScript
-   Works on any Discord branch: Stable, Canary or PTB all work
-   Custom CSS and Themes: Inbuilt css editor with support to import any css files (including BetterDiscord themes)
-   Privacy friendly: blocks Discord analytics & crash reporting out of the box and has no telemetry
-   Maintained very actively, broken plugins are usually fixed within 12 hours
-   Settings sync: Keep your plugins and their settings synchronised between devices / apps (optional)


## Installing / Uninstalling

Visit https://limey-discord.onrender.com/download

## Join our Support/Community Server

https://discord.gg/n8rmQJRAzV

## Disclaimer

Discord is trademark of Discord Inc. and solely mentioned for the sake of descriptivity.
Mention of it does not imply any affiliation with or endorsement by Discord Inc.

<details>
<summary>Using Limey V1 violates Discord's terms of service</summary>

Client modifications are against Discord’s Terms of Service.

However, Discord is pretty indifferent about them and there are no known cases of users getting banned for using client mods! So you should generally be fine as long as you don’t use any plugins that implement abusive behaviour. But no worries, all inbuilt plugins are safe to use!

Regardless, if your account is very important to you and it getting disabled would be a disaster for you, you should probably not use any client mods (not exclusive to Limey V1), just to be safe

Additionally, make sure not to post screenshots with Limey V1 in a server where you might get banned for it

</details>

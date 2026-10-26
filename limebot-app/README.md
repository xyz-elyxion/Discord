# Limebot app

A small desktop app that runs the Limebot Discord bot ([`../bot`](../bot)) without a terminal, git or pnpm. Made for volunteers: paste the bot token, press **Start bot**, watch the console.

The app is a supervisor, not a reimplementation. It starts the bot's own `run.js` launcher as a child process, so first boot still installs dependencies and builds `dist/` exactly as a manual run does — that first start takes a few minutes and its progress is printed in the console pane.

## For volunteers

1. Download the Limebot app for your OS and unzip it.
2. Install [Node.js](https://nodejs.org/) 20 or newer once (the app tells you if it is missing).
3. Open **Limebot**, paste a bot token into the token field, press **Start bot**.
4. Leave the window open. **Stop** shuts the bot down; closing the window does the same.

The token is saved only on that computer, in the app's user-data folder (`settings.json`, owner-readable only), and is passed to the bot as `LIMEBOT_TOKEN`. Get a token from the [Discord Developer Portal](https://discord.com/developers/applications) → your application → Bot → Reset Token.

A copy of `bot/` ships inside the app and is unpacked into the user-data folder on first launch (`limebot-runtime/`). It is refreshed when the app version changes, keeping the installed `node_modules` so the volunteer does not pay for a full reinstall on every app update. **Change folder…** in the footer points the app at a checkout instead — handy while developing the bot.

## Development

```sh
pnpm install          # from the repo root; limebot-app is a workspace member
cd limebot-app
pnpm dev              # runs the app against the sibling bot/ checkout
pnpm check            # syntax check of the main/preload/renderer scripts
pnpm build:linux      # tar.gz in limebot-app/dist
pnpm build:win        # portable zip (no installer, no code signing)
```

`pnpm dev` outside a packaged build looks for `../bot/run.js`, so changes to the bot are picked up straight away.

## Layout

| File | Role |
| --- | --- |
| `src/main.js` | Electron main process: window, settings, bundled-bot unpacking, IPC |
| `src/core.js` | `BotSupervisor` (spawn, line-buffered logs, stop/restart, process-tree kill) and the Node.js check — no Electron imports, runnable with plain Node |
| `src/preload.js` | The only bridge into the window (`contextIsolation`, no Node in the renderer) |
| `src/renderer/` | The window: token field, buttons, status pill and console |

Stopping is deliberate about process trees: the bot is spawned in its own process group on macOS/Linux and killed with `taskkill /T` on Windows, because `run.js` spawns `npm` which spawns its own children. A stop that is ignored for 10 seconds is escalated to `SIGKILL`.

## License

GPL-3.0-or-later, same as the rest of Limey V1.

/* Launcher shim.
 *
 * Some hosts (e.g. WispByte) run a fixed startup file —
 * `node dist/botOnly.js` at the repo root — and cannot have their startup
 * command edited to point elsewhere. This file IS that startup path: it just
 * forwards to bot/run.js, which on first boot installs dependencies,
 * builds bot/dist with esbuild and starts the bot-only entry. It never
 * contains prebuilt bot code — the real bundle is still built from source.
 */
require("../bot/run.js");

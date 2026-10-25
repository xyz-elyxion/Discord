/*
 * Launcher shim.
 *
 * The web server (site pages, admin panel, /v1/* APIs, all the single-file
 * backends) now lives in web/. This file is kept at the repo root because
 * several hosts hardcode their start command at `node server.js` (Render,
 * Docker CMD, package.json main). It just forwards to web/server.js.
 */
require("./web/server.js");

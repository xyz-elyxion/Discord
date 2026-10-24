/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Fully separated HTTP-only startup: runs ONLY the Fastify service
 * (verification, dashboard setup, GitHub linking, Limey V1 reporter).
 * No gateway session, no commands, no moderation — the bot process
 * (dist/botOnly.js) and this process are fully separated; where the bot
 * needs anything shared it talks to the render server over HTTP
 * (see util/persist.ts and config.limeyApiBase).
 *
 * The Discord client is initialized via Oceanic's restMode so Vaius.user
 * and REST auth work without holding a gateway session (which would
 * conflict with the bot process). Guild caches are hydrated on demand
 * over HTTP by the hook in server.ts.
 *
 * Run with:
 *   pnpm build && node --enable-source-maps dist/serverOnly.js
 * or simply:
 *   pnpm startServer
 */

import { Vaius } from "./Client";
import Config from "./config";
import { restoreBotState, startBotStateSync } from "./util/persist";

import "./server";

async function main() {
    // REST-only init: populates user/application without a gateway READY.
    // The bot process connects for real via index.ts instead.
    try {
        await Vaius.restMode();
        console.log(`[server] REST-only Discord client initialized as @${Vaius.user?.username ?? "unknown"} (no gateway session)`);
    } catch (e) {
        console.error("[server] failed to initialize the REST-only Discord client:", e);
    }

    // Before serving any requests, pull durable feature configs from the v1
    // server (util/persist.ts → /v1/bot-state), then keep syncing two-way
    // forever so dashboard edits reach v1 and remote edits show up here.
    await restoreBotState();
    startBotStateSync();

    if (!Config.httpServer.enabled) {
        console.error("[server] config.httpServer.enabled is false — nothing to run in server-only mode, exiting");
        process.exit(1);
    }
    // fastify.listen (server.ts) keeps the process alive from here on.
}

void main();

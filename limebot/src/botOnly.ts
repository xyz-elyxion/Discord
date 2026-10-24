/*
 * Limebot
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Bot-only startup — runs the gateway client, commands and modules WITHOUT
 * the Fastify HTTP server (GitHub linking, Limey V1 reporter, verification
 * endpoints, …). Modules that need the HTTP server still import it, but it
 * never listens: server.ts skips fastify.listen when this flag is set.
 *
 * Run with:
 *   pnpm build && node --enable-source-maps dist/botOnly.js
 * or simply:
 *   pnpm startBotOnly
 */

// Set before importing index so the flag is already in the environment when
// the deferred server-start check runs.
process.env.LIMEBOT_BOT_ONLY = "1";

import "./index";

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PluginTargets = ["web", "browser", "discordDesktop", "vesktop", "desktop", "dev"] as const;
export type PluginTarget = typeof PluginTargets[number];

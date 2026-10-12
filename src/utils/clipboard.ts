/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function copyToClipboard(text: string): Promise<void> {
    return IS_DISCORD_DESKTOP ? DiscordNative.clipboard.copy(text) : navigator.clipboard.writeText(text);
}

export async function readClipboard(): Promise<string> {
    if (IS_DISCORD_DESKTOP) return DiscordNative.clipboard.read();
    try {
        return await navigator.clipboard.readText();
    } catch {
        // web clipboard reads can be blocked without user permission
        return "";
    }
}

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface CompanionEntry {
    /** Keywords the question is matched against (lowercase) */
    keywords: string[];
    /** The predefined answer picked when this entry matches best */
    answer: string;
    /** Optional label shown above the answer, e.g. "Discord" or "Limey V1" */
    topic: "Discord" | "Limey V1";
}

export const knowledgeBase: CompanionEntry[] = [
    {
        topic: "Limey V1",
        keywords: ["what", "limey", "v1", "mod", "client", "about"],
        answer: "Limey V1 is a Discord client mod — it injects into your Discord app and adds plugins, themes, a custom CSS editor, privacy tweaks and more. It is a fork lineage of Vencord, maintained actively by Limey and contributors."
    },
    {
        topic: "Limey V1",
        keywords: ["install", "download", "setup", "get"],
        answer: "Install Limey V1 from https://limey-discord.onrender.com/download — the installer patches your Discord app automatically. There is also a browser extension and a userscript if you prefer not to patch the desktop app."
    },
    {
        topic: "Limey V1",
        keywords: ["uninstall"],
        answer: "Run the Limey V1 installer again and choose Uninstall — it restores the original Discord files. You can also just reinstall Discord itself."
    },
    {
        topic: "Limey V1",
        keywords: ["ban", "banned", "tos", "terms", "safe", "risk", "danger"],
        answer: "Client mods technically violate Discord's Terms of Service, but Discord is indifferent to them and there are no known bans for using Limey V1. Keep it low-key: don't post screenshots with visible mods in servers where you might get reported, and if your account is precious, weigh the (tiny) risk yourself."
    },
    {
        topic: "Limey V1",
        keywords: ["plugin", "plugins", "enable", "list"],
        answer: "Open Settings → Plugins to browse 100+ built-in plugins. Toggle one on and (for most) it works instantly. The catalog lives at https://limey-discord.onrender.com/plugins too."
    },
    {
        topic: "Limey V1",
        keywords: ["theme", "themes", "css", "custom", "style"],
        answer: "Go to Settings → Themes (or QuickCSS) to paste any CSS — including BetterDiscord themes. The built-in editor even has autocompletion."
    },
    {
        topic: "Limey V1",
        keywords: ["update", "updates", "outdated", "new version"],
        answer: "Limey V1 keeps itself fresh: installed copies update from the Limey V1 website automatically, and broken plugins are usually fixed within hours of a Discord update. Check Settings → Updater for the current state."
    },
    {
        topic: "Limey V1",
        keywords: ["settings", "sync", "cloud", "backup"],
        answer: "Settings Sync keeps your plugins and their settings synchronised between devices. Enable Cloud Integrations in Settings → Settings Sync, authorize once, and your config follows you everywhere."
    },
    {
        topic: "Limey V1",
        keywords: ["telemetry", "privacy", "tracking", "data"],
        answer: "Limey V1 blocks Discord's analytics and crash reporting out of the box and ships with zero telemetry of its own."
    },
    {
        topic: "Limey V1",
        keywords: ["support", "help", "server", "discord", "community", "contact"],
        answer: "Join the support server: https://discord.gg/n8rmQJRAzV — broken plugins get fixed fast, and the team is friendly."
    },
    {
        topic: "Discord",
        keywords: ["what", "discord", "app", "platform"],
        answer: "Discord is a chat/voice platform for communities: servers (guilds) with text channels, voice channels, DMs, bots, and rich presence. The desktop app is Electron-based, which is exactly why client mods like Limey V1 can patch it."
    },
    {
        topic: "Discord",
        keywords: ["nitro", "subscription", "premium", "boost"],
        answer: "Nitro is Discord's paid subscription: bigger uploads, emoji anywhere, HD streaming, profile decorations, and boosts. Server Boosts level up a specific server with perks like better audio and more emoji slots."
    },
    {
        topic: "Discord",
        keywords: ["bot", "bots"],
        answer: "Bots are automated accounts with an API token. They listen to commands or events and can moderate, play music, and more. Some Limey V1 plugins even let you use bot commands in normal chat."
    },
    {
        topic: "Discord",
        keywords: ["server", "guild", "create"],
        answer: "A server (internally a 'guild') is your community space. Click the + in the server list to create one — channels, roles and permissions are all configurable from Server Settings."
    },
    {
        topic: "Discord",
        keywords: ["channel", "voice", "vc"],
        answer: "Channels come in two flavours: text channels (typed chat, threads, forums) and voice channels (live audio, screen share, Go Live). Just click a voice channel to join."
    },
    {
        topic: "Discord",
        keywords: ["emoji", "emote", "sticker", "kaomoji"],
        answer: "Emoji are per-server unless you have Nitro. The picker also has stickers and GIFs — and with the BringBackKaomojiPicker plugin installed here, you even get the old kaomoji tab back. ^▽^"
    },
    {
        topic: "Discord",
        keywords: ["role", "permission", "moderator", "admin"],
        answer: "Roles group members and carry permissions (kick, ban, manage messages…). Permissions stack across roles, and channel overrides can allow or deny them per channel."
    },
    {
        topic: "Discord",
        keywords: ["stream", "screenshare", "go live"],
        answer: "In a voice channel, hit 'Share Your Screen' or 'Go Live' to broadcast your screen or a game. Nitro unlocks higher resolutions and framerate."
    },
    {
        topic: "Discord",
        keywords: ["markdown", "format", "bold", "spoiler"],
        answer: "Chat supports markdown: **bold**, *italic*, __underline__, ~~strikethrough~~, `code`, ```code blocks``` and ||spoilers||."
    },
    {
        topic: "Discord",
        keywords: ["dm", "message", "private"],
        answer: "DMs are direct messages between users (or small group DMs). You can DM anyone who shares a server with you, unless their privacy settings block it."
    }
];

/** Fallback when nothing matches well enough */
export const fallbackAnswer = "Hmm, I don't have a canned answer for that one. Try asking about Limey V1 (install, plugins, themes, updates, safety) or Discord basics (servers, roles, Nitro, markdown) — or drop by the support server: https://discord.gg/n8rmQJRAzV";

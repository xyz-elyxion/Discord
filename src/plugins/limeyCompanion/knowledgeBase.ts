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
    topic: "Discord" | "Limey V1" | "Tips";
}

export const knowledgeBase: CompanionEntry[] = [
    // ─── Limey V1 basics ────────────────────────────────────────────────
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
    // ─── Discord basics ────────────────────────────────────────────────
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
    },

    // ─── Limey V1 deep dive ─────────────────────────────────────────────
    {
        topic: "Limey V1",
        keywords: ["quickcss", "editor", "monaco", "autocomplete"],
        answer: "QuickCSS is the built-in live CSS editor (powered by Monaco, the editor VS Code uses). Anything you type applies to Discord instantly and syncs across devices with Settings Sync."
    },
    {
        topic: "Limey V1",
        keywords: ["betterdiscord", "bd", "themes compatible", "convert"],
        answer: "Limey V1 can import BetterDiscord themes directly — just paste the BD theme CSS into QuickCSS or drop the .theme.css file into your themes folder. Most BD themes work out of the box."
    },
    {
        topic: "Limey V1",
        keywords: ["updater", "up to date", "behind"],
        answer: "The Updater panel (Settings → Updater) shows your current version, build time, and whether you're behind upstream. If an update broke something, hit 'Update' again or ask in the support server."
    },
    {
        topic: "Limey V1",
        keywords: ["permissions", "review", "dangerous", "trust"],
        answer: "Plugins with special abilities (network access, message reading…) declare permissions. The Permissions Manager shows exactly what each enabled plugin can do and lets you audit or revoke trust."
    },
    {
        topic: "Limey V1",
        keywords: ["userplugins", "write", "make", "own plugin", "developer"],
        answer: "You can write your own plugins! Drop them in src/userplugins, rebuild, and they appear in the plugin list. They use the same definePlugin API as built-ins — look at any built-in plugin's source for an example."
    },
    {
        topic: "Limey V1",
        keywords: ["settings search", "find setting"],
        answer: "Discord's settings search only covers its own settings — but Limey V1's panels are searchable too, and every plugin adds its settings under Settings → Plugins → <plugin name>."
    },
    {
        topic: "Limey V1",
        keywords: ["keyboard", "shortcut", "keybind", "hotkey"],
        answer: "Discord has built-in keybinds (Settings → Keybinds) and plugins can register their own. Check each plugin's settings for shortcuts — for example QuickCSS and many toggles support hotkeys."
    },
    {
        topic: "Limey V1",
        keywords: ["web", "browser", "extension", "userscript", "firefox", "chrome"],
        answer: "Limey V1 runs in the browser too: the extension works in Chrome/Firefox, and there's a userscript for Tampermonkey/Violentmonkey. Same plugins, same features, no desktop patching."
    },
    {
        topic: "Limey V1",
        keywords: ["standalone", "portable", "vesktop"],
        answer: "Besides patching the official app, there's Vesktop — a lightweight standalone Discord client that ships Limey V1 built-in. Great on Linux and for low-resource machines."
    },
    {
        topic: "Limey V1",
        keywords: ["linux", "flatpak", "snap", "macos", "windows"],
        answer: "Limey V1 supports Discord Stable/Canary/PTB on Windows, macOS and Linux (including Flatpak and system Electron installs). The installer detects all of them automatically."
    },
    {
        topic: "Limey V1",
        keywords: ["experiment", "experiments", "devtools", "toggle"],
        answer: "Plugins can unlock Discord's hidden experiments and developer options. Look for plugins in the catalog that expose experiments — enabling them lets you try features Discord hasn't shipped yet."
    },
    {
        topic: "Limey V1",
        keywords: ["notification", "notifications", "toast"],
        answer: "Limey V1 has its own in-app notification system used by plugins and the cloud integration — opaque themed toasts in the corner, with a notification log so you never miss one."
    },
    {
        topic: "Limey V1",
        keywords: ["badge", "badges", "profile"],
        answer: "The BadgeAPI plugin adds profile badges — donor badges, Limey V1 detector badge (shows when someone else runs Limey V1 🍋), and more. Some badges require linking with the cloud."
    },
    {
        topic: "Limey V1",
        keywords: ["commands", "slash", "chat bar", "shortcut"],
        answer: "Limey V1 plugins can register slash-like commands in the chat bar (type / and look for the Limey V1 section): petpet image generation, greeting stickers, custom RPC control, and more."
    },
    {
        topic: "Limey V1",
        keywords: ["toolbox", "toolbar"],
        answer: "The Limey V1 Toolbox is a quick-access menu (check the settings UI) with plugin-specific quick actions — handy toggles without digging through settings."
    },
    {
        topic: "Limey V1",
        keywords: ["broken", "crash", "error", "not working", "fails", "bug"],
        answer: "First: update Limey V1 (Settings → Updater). Still broken? Disable your plugins one by one to find the culprit, then report it in the support server (https://discord.gg/n8rmQJRAzV) — include your build hash from the Updater panel."
    },
    {
        topic: "Limey V1",
        keywords: ["safe mode", "disable all", "recovery"],
        answer: "If Discord won't start with Limey V1, relaunch with your system's 'start Discord' while holding nothing special — Limey V1 keeps a way to disable plugins from the installer, or you can reset via reinstalling Discord."
    },

    // ─── Discord deep dive ──────────────────────────────────────────────
    {
        topic: "Discord",
        keywords: ["thread", "threads"],
        answer: "Threads are side conversations branching off a message in a channel. They keep the main channel clean while preserving the discussion — create one via the message context menu."
    },
    {
        topic: "Discord",
        keywords: ["forum", "forums"],
        answer: "Forum channels are channel-level message boards: each post is its own thread with a title and tags. Great for support communities and showcases."
    },
    {
        topic: "Discord",
        keywords: ["stage", "stages", "audio room", "event"],
        answer: "Stage channels are like audience/speaker audio rooms — moderators control who talks. Use them for AMAs, presentations and events; schedule them with Guild Events."
    },
    {
        topic: "Discord",
        keywords: ["announcement", "news", "follow", "publish"],
        answer: "Announcement channels let servers publish posts that other servers can follow — followers receive them automatically. Perfect for cross-server news."
    },
    {
        topic: "Discord",
        keywords: ["invite", "invites", "link"],
        answer: "Invites can be permanent, expire after a time/use limit, or be revoked anytime. You manage them per channel in Server Settings → Invites, and can track who used them."
    },
    {
        topic: "Discord",
        keywords: ["pinned", "pin", "message"],
        answer: "Pin important messages via the message context menu — they collect in the channel's Pins view so nobody scrolls forever to find them."
    },
    {
        topic: "Discord",
        keywords: ["reaction", "reactions", "react"],
        answer: "Reactions are emoji attached to messages (hover a message → smiley face). They're used for polls, acknowledgements and fun. Discord shows counts per emoji."
    },
    {
        topic: "Discord",
        keywords: ["status", "presence", "online", "idle", "dnd", "invisible", "away"],
        answer: "Your presence: Online, Idle, Do Not Disturb (silences notifications) and Invisible (appears offline while still chatting). Set it from your avatar menu."
    },
    {
        topic: "Discord",
        keywords: ["custom status", "rpc", "rich presence", "now playing"],
        answer: "Custom status is a small text+emoji next to your name. Rich Presence comes from running games/apps — and with Limey V1's customRPC plugin you can set your own fake 'Now Playing'."
    },
    {
        topic: "Discord",
        keywords: ["activity", "activities", "games", "watch together"],
        answer: "Activities are embedded games/apps you can run in voice channels: Watch Together, Poker, Gartic Phone and more. Start them from the Activities rocket button in a VC."
    },
    {
        topic: "Discord",
        keywords: ["webhook", "webhooks"],
        answer: "Webhooks let external services post messages into a channel via a URL — CI alerts, feeds, integrations. Create one in Channel Settings → Integrations."
    },
    {
        topic: "Discord",
        keywords: ["audit", "log", "who did"],
        answer: "The Audit Log (Server Settings → Audit Log) records every admin action: who banned whom, who edited roles, who deleted messages' channels, and when."
    },
    {
        topic: "Discord",
        keywords: ["automod", "auto moderation", "filter", "spam"],
        answer: "AutoMod is Discord's built-in moderation: block banned words, spam patterns and mention floods before they post. Configure it in Server Settings → AutoMod."
    },
    {
        topic: "Discord",
        keywords: ["verification", "verify", "phone", "level"],
        answer: "Server verification levels (None → Low → Medium → High → Highest) gate who can talk: verified email, account age, or phone. Anti-raid protection at scale."
    },
    {
        topic: "Discord",
        keywords: ["timeout", "time out", "mute member"],
        answer: "Timeout silences a member (no messages/voice) for minutes or days without removing them — a softer alternative to kick/ban. Right-click a member → Timeout."
    },
    {
        topic: "Discord",
        keywords: ["kick", "ban", "moderation"],
        answer: "Kick removes someone (they can rejoin), ban removes and blocks them (unless unbanned). Right-click the member → Kick/Ban, with an optional message and message deletion window."
    },
    {
        topic: "Discord",
        keywords: ["onboarding", "welcome", "community setup"],
        answer: "Community servers can use Onboarding: new members pick interest roles and see a custom welcome. Set it up in Server Settings → Onboarding (requires Community enabled)."
    },
    {
        topic: "Discord",
        keywords: ["community", "discovery", "public"],
        answer: "Enabling Community unlocks forums, discovery, announcement channels and more (Server Settings → Enable Community). Discovery lists public servers matching quality criteria."
    },
    {
        topic: "Discord",
        keywords: ["family center", "parent", "teen", "safety"],
        answer: "Family Center lets parents see (not read) a teen's activity: servers joined, new friends, and safety settings — a transparency overview without message access."
    },
    {
        topic: "Discord",
        keywords: ["soundboard", "sounds"],
        answer: "Soundboard lets you play short audio clips in voice channels — upload sounds per server or use defaults. Volume-limited to keep VCs sane."
    },
    {
        topic: "Discord",
        keywords: ["clip", "clips", "capture"],
        answer: "Clips record the last 30 seconds of a stream or Go Live session so you can share the moment. Enable clips in your Voice & Video settings."
    },
    {
        topic: "Discord",
        keywords: ["poll", "polls", "vote"],
        answer: "You can create polls right in the message box (the + button → Create Poll): up to 10 answers, timed or instant, with live vote counts."
    },
    {
        topic: "Discord",
        keywords: ["gift", "gifts", "shop", "profile effect", "avatar decoration"],
        answer: "The Shop sells profile effects, avatar decorations, gift-able Nitro, and server boosts. Gifts can be sent directly in DMs — wrapping paper included 🎁."
    },
    {
        topic: "Discord",
        keywords: ["hype", "hypesquad", "brilliance", "bravery", "balance"],
        answer: "HypeSquad is Discord's community program: the online House (join from User Settings) and event attendees get exclusive badges — Brilliance, Bravery or Balance."
    },
    {
        topic: "Discord",
        keywords: ["student", "hub", "school"],
        answer: "Student Hubs connect school communities: join with your school email and discover servers of classmates without merging them into one big server."
    },

    // ─── Tips & tricks ──────────────────────────────────────────────────
    {
        topic: "Tips",
        keywords: ["notification", "mute", "channel", "annoying"],
        answer: "Mute noisy channels per-channel (right-click → Mute) with durations from 15 minutes to forever, and choose to silence only mentions or everything. Category mutes cascade."
    },
    {
        topic: "Tips",
        keywords: ["search", "find message", "history"],
        answer: "The search bar filters by server, channel, from-user, has-link, has-file, before/after dates… e.g. 'from:friend after:2024-01-01'. Power-search like a pro."
    },
    {
        topic: "Tips",
        keywords: ["fastest", "speed", "jumps", "unread"],
        answer: "Alt+↑/↓ jumps between channels, and clicking a server's unread badge teleports to the first unread channel. The pulse on the server icon shows where chatter is."
    },
    {
        topic: "Tips",
        keywords: ["voice quality", "audio", "mic", "noise", "echo"],
        answer: "Voice & Video settings: enable noise suppression (Krisp), echo cancellation, and automatic gain. Push-to-talk vs voice activity is per-keybind — test your mic in the built-in check."
    },
    {
        topic: "Tips",
        keywords: ["data usage", "bandwidth", "slow"],
        answer: "Stream quality and video quality can be capped per-call via the call quality gear icon. Lower resolution = less bandwidth. Images load lighter with 'data saver' style settings."
    },
    {
        topic: "Tips",
        keywords: ["quick switcher", "ctrl k", "jump to"],
        answer: "Ctrl+K (Cmd+K on Mac) opens the Quick Switcher: type a channel, DM or server name and jump instantly. Learn this one — it's the fastest way around Discord."
    },
    {
        topic: "Tips",
        keywords: ["tts", "text to speech", "read aloud"],
        answer: "/tts sends a spoken message to everyone with TTS enabled (use sparingly!). You control whether you hear TTS and when in your Text & Images settings."
    },
    {
        topic: "Tips",
        keywords: ["gif", "giphy", "tenor", "animated"],
        answer: "Type :gif: style or use the GIF picker (tenor-backed) — searching 'excited cat' finds exactly what you expect. Favoriting GIFs keeps them handy across devices."
    },
    {
        topic: "Tips",
        keywords: ["folders", "server folder", "organize"],
        answer: "Drag one server icon onto another to create a folder; folders collapse, can be named, colored, and expand on hover or click — your server list stays tidy."
    },
    {
        topic: "Tips",
        keywords: ["declutter", "clean", "minimal", "compact"],
        answer: "Toggle Cozy/Compact chat density in Appearance settings, disable embedded media and emoji animations there too — Discord can be as minimal as you like (and Limey V1 plugins go further)."
    }
];

/** Fallback when nothing matches well enough */
export const fallbackAnswer = "Hmm, I don't have a canned answer for that one. Try asking about Limey V1 (install, plugins, themes, updates, safety, permissions, custom RPC, toolbox) or Discord basics (servers, roles, Nitro, threads, forums, stages, polls, soundboard) — or drop by the support server: https://discord.gg/n8rmQJRAzV";

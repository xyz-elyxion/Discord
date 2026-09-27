# QuestCompleter

Automatically enrolls in and completes Discord **Quests**, ported from
[aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot](https://github.com/aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot).

## What it does

- Detects your active quests via `/quests/@me`
- Enrolls automatically (or manually via `/quests start`)
- Completes the following quest types:
    - **Watch video** quests (`WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`) — spoofs video progress
    - **Play on desktop / Xbox / PlayStation** quests — sends game heartbeats
    - **Play activity** quests — sends activity heartbeats
    - **Achievement in activity** quests — authorizes the activity, reports progress via
      the `.discordsays.com` proxy, then deauthorizes
- Optionally claims rewards (`autoRedeem`)

Stream quests (`STREAM_ON_DESKTOP`) cannot be spoofed and are skipped with a notice.

## Usage

- `/quests start` — process all eligible quests
- `/quests list` — list quests known to the client
- Toolbox action **Run Quests** — same as `/quests start`
- Configure behavior in plugin settings (`autoEnroll`, `autoEnrollNew`, `autoRedeem`, `silentMode`)

> **Note:** Progress is verified by Discord's servers — play/video quests still take their
> real-world time to complete (the plugin keeps the client warm with heartbeats). Enrollment
> is heavily rate-limited (~45 minutes), so failed enrollments are not retried immediately.

> **Disclaimer:** Automating quests may violate Discord's Terms of Service. Use at your own risk.

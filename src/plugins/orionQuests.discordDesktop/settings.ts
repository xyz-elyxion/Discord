/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { fireAchievementBypassChanged, fireOrbQuestsOnlyChanged, fireWatchForEnrollmentsChanged } from "./hooks";

export const settings = definePluginSettings({
    autoStart: {
        type: OptionType.BOOLEAN,
        description:
            "Start the engine automatically when the plugin loads. Otherwise use the /orion start slash command.",
        default: false,
    },

    autoEnroll: {
        type: OptionType.BOOLEAN,
        description:
            "Accept quests for you before running them. Turn it off to run only the quests you accepted yourself in Discord's Quests page: anything you haven't accepted is left untouched and listed as PENDING in /orion status, and it starts on the next cycle the moment you accept it, without restarting the engine.",
        default: true,
    },

    orbQuestsOnly: {
        type: OptionType.BOOLEAN,
        description:
            "Run only quests that pay Orbs. Every other quest is left alone for the run: not accepted, not started, and not counted as a failure. A quest counts when any of its rewards carries Orbs, not only the first one, since Discord can list an in-game item ahead of the Orbs. Quests already running when you turn this on are allowed to finish. Turning it off mid-run puts the quests it left out back in on the next cycle.",
        default: false,
        onChange: (value: boolean) => fireOrbQuestsOnlyChanged(value),
    },

    watchForEnrollments: {
        type: OptionType.BOOLEAN,
        description:
            "Watch Discord's quest list while the engine is idle and start it on its own when you accept a quest, instead of you running /orion start. The engine can then start while you are away from the keyboard, which is a change in exposure under Discord's quest-automation enforcement rather than only a convenience: turning it on is your explicit consent to that. /orion stop disarms the watcher until the next /orion start, and disabling the plugin removes it entirely. Note it does not narrow what a run picks up: with auto-enroll also on, accepting one quest wakes the engine and it then enrolls you in every other available quest, so pair this with auto-enroll off if you want only the quests you accepted yourself.",
        default: false,
        onChange: (value: boolean) => fireWatchForEnrollmentsChanged(value),
    },

    achievementBypass: {
        type: OptionType.BOOLEAN,
        description:
            "Auto-complete ACHIEVEMENT_IN_ACTIVITY quests by OAuth-authorizing the quest's app on your account (scopes: identify, applications.commands, applications.entitlements), reporting progress to the activity backend, then revoking the grant right after. This automates your logged-in account and can put the WHOLE account at risk under Discord's quest-automation enforcement. Off by default: turning it on is your explicit consent. Turning it on mid-run puts back any quest that was skipped only because it was off.",
        default: false,
        onChange: (value: boolean) => fireAchievementBypassChanged(value),
    },

    tryToClaimReward: {
        type: OptionType.BOOLEAN,
        description:
            "Try to auto-claim rewards immediately on completion. May trigger a captcha, so disable it if you'd rather click CLAIM in Discord's Quests page manually.",
        default: false,
    },

    hideActivity: {
        type: OptionType.BOOLEAN,
        description:
            "Suppress 'Playing ...' status from your friends list while game quests are running. Turns Discord's own 'Display current activity as a status message' off for the duration and restores it afterwards. The store spoof alone is what Discord builds the status from, so nothing less hides it. Takes effect immediately, including on a quest already in progress.",
        default: false,
    },

    playSessionTail: {
        type: OptionType.SLIDER,
        description:
            "Minutes to keep a game quest's spoofed process running after the quest completes, picked at random between 40% and 100% of this value each time. Without it the fake session ends on the exact heartbeat that crossed the quest's requirement, so its length is always precisely the requirement, on every quest. Real play overshoots by a different amount every time, and r/DiscordQuests' suspension megathread reports that finishing at exactly the quest duration is among the patterns being flagged, though nobody outside Discord has measured what its detector actually weighs. Costs no extra requests: Discord ends the quest heartbeat itself the moment it sees the completion, so this only extends the 'Playing ...' presence. Set to 0 to drop the process immediately. Stop releases it at once either way.",
        markers: [0, 1, 2, 3, 5, 8],
        stickToMarkers: true,
        default: 2,
    },

    gameConcurrency: {
        type: OptionType.SLIDER,
        description:
            "Parallel game quests. Values above 1 risk detection, so keep it at 1 unless you know what you're doing. Read when a cycle starts, so a change applies to the next batch rather than to tasks already in flight.",
        markers: [1, 2, 3],
        stickToMarkers: true,
        default: 1,
    },

    videoConcurrency: {
        type: OptionType.SLIDER,
        description:
            "Parallel video quests. Higher values finish faster but make more API calls. Read when a cycle starts, so a change applies to the next batch rather than to tasks already in flight.",
        markers: [1, 2, 3, 4],
        stickToMarkers: true,
        default: 2,
    },

    playSound: {
        type: OptionType.BOOLEAN,
        description:
            "Play a soft tone after each quest completes and a 3-note arpeggio when the whole queue finishes. Useful when running with auto-claim off so you can come back to claim before the captcha times out.",
        default: false,
    },

    verboseLogging: {
        type: OptionType.BOOLEAN,
        description:
            "Raise Orion's debug messages to info level so they show in the console without switching it to Verbose (useful for troubleshooting Discord changes).",
        default: false,
    },
});

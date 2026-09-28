/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { Command } from "@limeyV1/discord-types";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, showToast, Toasts } from "@webpack/common";

import {
    AllQuestsResponse,
    OAuthTokenInfo,
    Quest,
    QuestTaskConfigType,
} from "./types";

const logger = new Logger("QuestCompleter");

const settings = definePluginSettings({
    autoEnroll: {
        type: OptionType.BOOLEAN,
        description: "Automatically start completing enrolled quests on plugin start",
        default: true
    },
    autoEnrollNew: {
        type: OptionType.BOOLEAN,
        description: "Automatically enroll in new quests as they appear",
        default: false
    },
    autoRedeem: {
        type: OptionType.BOOLEAN,
        description: "Automatically claim rewards when a quest completes",
        default: false
    },
    verbose: {
        type: OptionType.BOOLEAN,
        description: "Show a toast on every progress step (off = only on enrollment/completion/failure)",
        default: false
    }
});

function notify(message: string, always = false) {
    if (always || settings.store.verbose) {
        showToast(message, Toasts.Type.MESSAGE);
    }
    logger.info(message);
}

function notifySuccess(message: string) {
    showToast(message, Toasts.Type.SUCCESS);
    logger.info(message);
}

function notifyFailure(message: string) {
    showToast(message, Toasts.Type.FAILURE);
    logger.error(message);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// The quest endpoints are not exposed through stores, so this plugin talks to
// the same REST surface as the reference selfbot. RestAPI attaches the user's
// auth token and client headers automatically.
function questGet(url: string) {
    return RestAPI.get({ url, retries: 2 }).then(res => res.body);
}

function questPost(url: string, body: Record<string, any>) {
    return RestAPI.post({ url, body, retries: 2 }).then(res => res.body);
}

function questDelete(url: string) {
    return RestAPI.del({ url }).then(res => res.body);
}

function isExpired(quest: Quest) {
    return Date.now() > new Date(quest.config.expires_at).getTime();
}

function isCompleted(quest: Quest) {
    return Boolean(quest.user_status?.completed_at);
}

function isEnrolled(quest: Quest) {
    return Boolean(quest.user_status?.enrolled_at);
}

function hasClaimedRewards(quest: Quest) {
    return Boolean(quest.user_status?.claimed_at);
}

function getTask(quest: Quest) {
    const tasks = quest.config.task_config_v2.tasks;
    const order: QuestTaskConfigType[] = [
        "WATCH_VIDEO",
        "PLAY_ON_DESKTOP",
        "PLAY_ON_XBOX",
        "PLAY_ON_PLAYSTATION",
        "STREAM_ON_DESKTOP",
        "PLAY_ACTIVITY",
        "WATCH_VIDEO_ON_MOBILE",
        "ACHIEVEMENT_IN_ACTIVITY"
    ];
    for (const name of order) {
        if (tasks[name]) return tasks[name]!;
    }
    return null;
}

function getProgress(quest: Quest, taskType: QuestTaskConfigType) {
    return quest.user_status?.progress?.[taskType]?.value ?? 0;
}

async function refreshQuest(quest: Quest) {
    const fresh = await questGet(`/quests/${quest.id}`) as Quest;
    if (fresh?.user_status) quest.user_status = fresh.user_status;
    return quest;
}

async function enrollQuest(quest: Quest, isAndroid: boolean) {
    const res = await questPost(`/quests/${quest.id}/enroll`, {
        location: isAndroid ? 12 : 11, // QUEST_HOME_MOBILE : QUEST_HOME_DESKTOP
        is_targeted: false,
        metadata_sealed: null,
        traffic_metadata_raw: quest.traffic_metadata_raw,
        traffic_metadata_sealed: quest.traffic_metadata_sealed
    });
    if (res) quest.user_status = res;
}

async function heartbeat(quest: Quest, body: Record<string, any>) {
    return questPost(`/quests/${quest.id}/heartbeat`, body);
}

async function videoProgress(quest: Quest, timestamp: number) {
    return questPost(`/quests/${quest.id}/video-progress`, { timestamp });
}

async function claimReward(quest: Quest) {
    const platform = quest.config.rewards_config.platforms[0];
    const res = await questPost(`/quests/${quest.id}/claim-reward`, {
        platform,
        location: 11,
        is_targeted: false,
        metadata_raw: null,
        metadata_sealed: null,
        traffic_metadata_raw: quest.traffic_metadata_raw,
        traffic_metadata_sealed: quest.traffic_metadata_sealed
    });
    if (res) quest.user_status = res;
}

async function completePlayQuest(quest: Quest, questName: string, applicationName: string, taskType: QuestTaskConfigType) {
    const interval = 20;
    const target = quest.config.task_config_v2.tasks[taskType]!.target;

    while (!isCompleted(quest)) {
        const secondsDone = getProgress(quest, taskType);
        const res = await heartbeat(quest, { application_id: quest.config.application.id, terminal: false });
        if (res) quest.user_status = res;
        notify(`${questName}: playing as ${applicationName} — ${Math.max(0, Math.ceil((target - secondsDone) / 60))} minute(s) remaining`);

        if (isCompleted(quest)) break;
        await sleep(interval * 1000);
        await refreshQuest(quest);
    }

    const res = await heartbeat(quest, { application_id: quest.config.application.id, terminal: true });
    if (res) quest.user_status = res;
}

async function completeActivityQuest(quest: Quest, questName: string, applicationName: string) {
    const interval = 20;
    const taskType: QuestTaskConfigType = "PLAY_ACTIVITY";
    const target = quest.config.task_config_v2.tasks[taskType]!.target;
    // call:channel_id:user_id or guild:guild_id:channel_id:user_id, "call:1:1" is accepted by the API
    const streamKey = "call:1:1";

    while (!isCompleted(quest)) {
        const secondsDone = getProgress(quest, taskType);
        const res = await heartbeat(quest, { stream_key: streamKey, terminal: false });
        if (res) quest.user_status = res;
        notify(`${questName}: playing activity ${applicationName} — ${Math.max(0, Math.ceil((target - secondsDone) / 60))} minute(s) remaining`);

        if (isCompleted(quest)) break;
        await sleep(interval * 1000);
        await refreshQuest(quest);
    }

    const res = await heartbeat(quest, { stream_key: streamKey, terminal: true });
    if (res) quest.user_status = res;
}

async function completeVideoQuest(quest: Quest, questName: string, taskType: QuestTaskConfigType, target: number) {
    // Discord only accepts timestamps up to the elapsed time since enrollment
    // (plus a small tolerance), so progress is sent in 7 second steps.
    const maxFuture = 10;
    const speed = 7;
    const interval = 7;
    const enrolledAt = new Date(quest.user_status?.enrolled_at ?? Date.now()).getTime();
    let secondsDone = getProgress(quest, taskType);

    let completed = isCompleted(quest);
    while (secondsDone < target && !completed) {
        const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
        const diff = maxAllowed - secondsDone;
        const timestamp = secondsDone + speed;

        if (diff >= speed) {
            const res = await videoProgress(quest, Math.min(target, timestamp + Math.random()));
            completed = res?.completed_at != null;
            secondsDone = Math.min(target, timestamp);
            notify(`${questName}: video progress ${Math.floor((secondsDone / target) * 100)}%`);
        }

        if (timestamp >= target) break;
        await sleep(interval * 1000);
    }

    if (!completed) {
        await videoProgress(quest, target);
    }
}

async function completeAchievementQuest(quest: Quest, questName: string, applicationName: string, target: number) {
    const applicationId = quest.config.application.id;

    // 1. Authorize the activity application (same flow as launching it)
    const authorizeRes = await questPost(
        `/oauth2/authorize?response_type=code&client_id=${applicationId}&scope=${encodeURIComponent("identify applications.commands applications.entitlements")}&state=`,
        {
            permissions: "0",
            authorize: true,
            integration_type: 1,
            location_context: {
                guild_id: "10000",
                channel_id: "10000",
                channel_type: 10000
            }
        }
    );

    const location: string | undefined = authorizeRes?.location;
    const authCode = location ? new URL(location).searchParams.get("code") : null;
    if (!authCode) {
        throw new Error(`No auth code received for ${applicationName}`);
    }
    notify(`${questName}: authorized activity ${applicationName}`);

    // 2. Get an activity proxy ticket to build the discordsays referrer
    const ticket = await questPost(`/applications/${applicationId}/proxy-tickets`, {});
    const referrer = new URL(`https://${applicationId}.discordsays.com/`);
    referrer.searchParams.set("instance_id", "example-cl-instance");
    referrer.searchParams.set("platform", "desktop");
    referrer.searchParams.set("discord_proxy_ticket", ticket.ticket);

    const activityHeaders = (token: string): Record<string, string> => ({
        "Content-Type": "application/json",
        "X-Auth-Token": token,
        "X-Discord-Quest-ID": quest.id,
        Referer: referrer.toString()
    });

    // 3. Authorize with the activity backend
    const authRes = await fetch(`https://${applicationId}.discordsays.com/.proxy/acf/authorize`, {
        method: "POST",
        headers: activityHeaders(""),
        body: JSON.stringify({ code: authCode })
    }).then(res => res.json()) as { token?: string };

    if (!authRes.token) {
        throw new Error(`Activity authorization failed for ${applicationName}`);
    }

    // 4. Report the full quest progress
    const progressRes = await fetch(`https://${applicationId}.discordsays.com/.proxy/acf/quest/progress`, {
        method: "POST",
        headers: activityHeaders(authRes.token),
        body: JSON.stringify({ progress: target })
    });

    if (!progressRes.ok) {
        throw new Error(`Activity progress request failed (${progressRes.status}) for ${applicationName}`);
    }

    // 5. Deauthorize the application again to clean up
    try {
        const tokens = await questGet("/oauth2/tokens") as OAuthTokenInfo[];
        const tokenInfo = tokens.find(token => token.application.id === applicationId);
        if (tokenInfo) {
            await questDelete(`/oauth2/tokens/${tokenInfo.id}`);
        }
    } catch (error) {
        logger.error("Failed to deauthorize application token", error);
    }
}

async function runQuest(quest: Quest) {
    const questName = quest.config.messages.quest_name;
    const applicationName = quest.config.application.name;

    const task = getTask(quest);
    if (!task) {
        notifyFailure(`${questName}: unknown quest type, complete it manually.`);
        return;
    }

    if (!isEnrolled(quest)) {
        const isAndroid = task.type === "WATCH_VIDEO_ON_MOBILE" && !quest.config.task_config_v2.tasks.WATCH_VIDEO;
        try {
            await enrollQuest(quest, isAndroid);
            notify(`${questName}: enrolled (${isAndroid ? "mobile" : "desktop"})`, true);
        } catch (error) {
            // enrollment is heavily rate-limited (~45 min), so a failure here is fatal for this run
            notifyFailure(`${questName}: failed to enroll — ${(error as Error).message}`);
            return;
        }
    }

    try {
        switch (task.type) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                await completeVideoQuest(quest, questName, task.type, task.target);
                break;
            case "PLAY_ON_DESKTOP":
            case "PLAY_ON_XBOX":
            case "PLAY_ON_PLAYSTATION":
                await completePlayQuest(quest, questName, applicationName, task.type);
                break;
            case "PLAY_ACTIVITY":
                await completeActivityQuest(quest, questName, applicationName);
                break;
            case "STREAM_ON_DESKTOP":
                notifyFailure(`${questName}: stream quests can't be spoofed — stream the game manually.`);
                return;
            case "ACHIEVEMENT_IN_ACTIVITY":
                await completeAchievementQuest(quest, questName, applicationName, task.target);
                break;
            default:
                notifyFailure(`${questName}: unsupported quest type ${task.type}.`);
                return;
        }

        await refreshQuest(quest);
        if (isCompleted(quest)) {
            notifySuccess(`${questName}: completed!`);
            if (settings.store.autoRedeem && !hasClaimedRewards(quest)) {
                try {
                    await claimReward(quest);
                    notifySuccess(`${questName}: reward claimed!`);
                } catch (error) {
                    notifyFailure(`${questName}: failed to claim reward — ${(error as Error).message}`);
                }
            }
        } else {
            notify(`${questName}: progress sent, but the quest is not marked complete yet.`);
        }
    } catch (error) {
        notifyFailure(`${questName}: ${(error as Error).message}`);
    }
}

const activeQuests = new Set<string>();

function startQuest(quest: Quest) {
    if (activeQuests.has(quest.id)) return;
    activeQuests.add(quest.id);
    runQuest(quest).finally(() => activeQuests.delete(quest.id));
}

async function fetchActiveQuests() {
    const response = await questGet("/quests/@me") as AllQuestsResponse;
    if (response.quest_enrollment_blocked_until) {
        throw new Error(`Quest enrollment is blocked until ${response.quest_enrollment_blocked_until}`);
    }
    return response.quests.filter(quest => !isExpired(quest) && !isCompleted(quest));
}

async function processQuests() {
    const quests = await fetchActiveQuests();

    notify(`Found ${quests.length} active quest(s).`, true);

    for (const quest of quests) {
        if (settings.store.autoEnrollNew || isEnrolled(quest)) {
            startQuest(quest);
        } else {
            notify(`${quest.config.messages.quest_name}: not enrolled, enable "Automatically enroll in new quests" to join it.`);
        }
    }
}

function makeQuestsCommand(): Command {
    return {
        name: "quests",
        description: "Quest Completer: view and auto-complete Discord quests",
        inputType: ApplicationCommandInputType.BUILT_IN,
        options: [
            {
                name: "action",
                description: "What to do",
                type: ApplicationCommandOptionType.STRING,
                required: true,
                choices: [
                    { name: "start", label: "Start all eligible quests", value: "start" },
                    { name: "list", label: "List active quests", value: "list" }
                ]
            }
        ],
        async execute(args, ctx) {
            const action = findOption<string>(args, "action", "list");

            if (action === "start") {
                processQuests().catch(error => {
                    logger.error("Failed to process quests", error);
                    sendBotMessage(ctx.channel.id, { content: `Quest Completer error: ${(error as Error).message}` });
                });
                return sendBotMessage(ctx.channel.id, { content: "Starting quest processing..." });
            }

            try {
                const quests = await fetchActiveQuests();
                const content = quests.length
                    ? quests.map(quest => {
                        const task = getTask(quest);
                        const enrolled = isEnrolled(quest);
                        return `• ${quest.config.messages.quest_name} (${quest.config.application.name}) — ${task?.type ?? "unknown task"}, ${enrolled ? "enrolled" : "not enrolled"}`;
                    }).join("\n")
                    : "No active quests.";

                return sendBotMessage(ctx.channel.id, { content });
            } catch (error) {
                logger.error("Failed to list quests", error);
                return sendBotMessage(ctx.channel.id, { content: `Quest Completer error: ${(error as Error).message}` });
            }
        }
    };
}

export default definePlugin({
    name: "QuestCompleter",
    permissions: [{
        id: "questCompletionSpoofing",
        title: "Authorize and spoof quest completions",
        description: "Performs OAuth authorization for activity applications and reports full quest completion without playing.",
        risk: "This is against Discord's terms of service and may result in quest rewards being revoked or account action."
    }],
    description: "Automatically enrolls in and completes Discord quests (video, play-on-desktop, activity, achievement) and optionally claims the rewards.",
    tags: ["Utility", "Fun"],
    authors: [Devs.Limey],
    settings,
    commands: [makeQuestsCommand()],
    toolboxActions: {
        "Run Quests": () => {
            processQuests().catch(error => logger.error("Failed to process quests", error));
        }
    },

    start() {
        if (!settings.store.autoEnroll) return;
        // Give the client time to settle after startup
        setTimeout(() => {
            processQuests().catch(error => logger.error("Failed to process quests", error));
        }, 10_000);
    },

    stop() {
        activeQuests.clear();
    }
});

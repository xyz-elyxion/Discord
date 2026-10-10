/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { type NotificationData,showNotification } from "@api/Notifications";
import { type Quest, QuestTaskType } from "@plugins/questify/utils/types";
import { Devs } from "@utils/constants";
import definePlugin, { IconComponent } from "@utils/types";
import { findByPropsLazy, findComponentByCodeLazy, findStoreLazy } from "@webpack";
import {
    ApplicationStreamingStore,
    ChannelStore,
    FluxDispatcher,
    GuildChannelStore,
    RestAPI,
    RunningGameStore
} from "@webpack/common";

const QuestStore = findStoreLazy("QuestStore") as { quests: Map<string, Quest>; };
const QuestIcon = findComponentByCodeLazy("10.47a.76.76") as IconComponent;

const StreamMetadataUtils = findByPropsLazy("getStreamerActiveStreamMetadata");

const supportedTasks: QuestTaskType[] = [
    QuestTaskType.WATCH_VIDEO,
    QuestTaskType.PLAY_ON_DESKTOP,
    QuestTaskType.STREAM_ON_DESKTOP,
    QuestTaskType.PLAY_ACTIVITY,
    QuestTaskType.WATCH_VIDEO_ON_MOBILE
];

function notify(title: string, body: string, options?: Partial<NotificationData>) {
    showNotification({ title, body, dismissOnClick: false, ...options });
}

function describeError(error: unknown) {
    const status = (error as { status?: number })?.status;
    const message = (error as Error)?.message ?? String(error);
    return status ? `HTTP ${status} - ${message}` : message;
}

function reportError(error: unknown) {
    console.error("[BetterQuestCompleter]", error);
    notify(
        "Better Quest Completer failed",
        describeError(error),
        { variant: "error" }
    );
}

async function runQuestLogic() {
    try {
        await runQuestLogicInner();
    } catch (error) {
        reportError(error);
    }
}

async function runQuestLogicInner() {
    const allQuests = [...QuestStore.quests.values()];
    const quests = allQuests.filter(quest => {
        try {
            return quest.userStatus?.enrolledAt
                && !quest.userStatus?.completedAt
                && new Date(quest.config.expiresAt).getTime() > Date.now()
                && quest.config.taskConfigV2?.tasks != null
                && supportedTasks.some(task => quest.config.taskConfigV2.tasks[task] != null);
        } catch (error) {
            console.warn("[BetterQuestCompleter] Skipping malformed quest", quest?.id, error);
            return false;
        }
    });

    if (quests.length === 0) {
        const enrolledNotDone = allQuests.filter(quest =>
            quest.userStatus?.enrolledAt
            && !quest.userStatus?.completedAt
        ).length;

        if (allQuests.length === 0) {
            notify(
                "No quests found",
                "Discord hasn't loaded any quests yet. Open the quest panel (Shop -> Quests) so it can fetch them, then click again.",
                { variant: "warning" }
            );
        } else if (enrolledNotDone === 0) {
            notify(
                "You have no enrolled quests",
                `Found ${allQuests.length} quests, but you haven't accepted any. Open the quest card and enroll first.`,
                { variant: "warning" }
            );
        } else {
            notify(
                "No completable quests",
                `Found ${enrolledNotDone} enrolled quest(s), but all are completed, expired, or not a spoofable task type.`,
                { variant: "warning" }
            );
        }
        return;
    }
    console.info("[BetterQuestCompleter] Working on", quests.length, "quest(s)");

    const doJob = async () => {
        const quest = quests.pop();
        if (!quest) return;

        const pid = Math.floor(Math.random() * 30000) + 1000;
        const applicationId = quest.config.application.id;
        const applicationName = quest.config.application.name;
        const questName = quest.config.messages?.questName ?? quest.config.application?.name ?? "Unknown quest";
        const taskName = supportedTasks.find(task => quest.config.taskConfigV2.tasks[task] != null)!;
        const secondsNeeded = quest.config.taskConfigV2.tasks[taskName]!.target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
        const isApp = typeof DiscordNative !== "undefined";

        const videoQuest = async () => {
            const maxFuture = 10, speed = 7, interval = 1;
            const enrolledAt = new Date(quest.userStatus!.enrolledAt).getTime();
            let completed = false;
            while (true) {
                const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                const diff = maxAllowed - secondsDone;
                const timestamp = secondsDone + speed;
                if (diff >= speed) {
                    const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) } })
                        .catch(error => {
                            throw new Error(`Video progress request failed: ${describeError(error)}`);
                        });
                    completed = res.body.completed_at != null;
                    secondsDone = Math.min(secondsNeeded, timestamp);
                }

                if (timestamp >= secondsNeeded) break;
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
            }
            if (!completed) {
                await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
            }
            notify("Quest completed!", `${questName} - quest was successfully completed.`, { variant: "success" });
            doJob().catch(reportError);
        };
        notify(`Spoofing video for: ${questName}.`, "This should finish within a minute.", { variant: "info" });
        await videoQuest();

        const playOnDesktopQuest = () => {
            if (!isApp) {
                notify(`Use the desktop app to complete the: ${applicationName} quest!`, "This no longer works in browser for non-video quests.");
                return;
            }
            RestAPI.get({ url: "/applications/public", query: { application_ids: applicationId } })
                .then(res => {
                const appData = res.body[0];
                const exeName = appData.executables?.find((exe: { os: string; name: string; }) => exe.os === "win32")?.name?.replace(">", "") ?? appData.name.replace(/[/\\:*?"<>|]/g, "");

                const fakeGame = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: appData.name,
                    pid,
                    pidPath: [pid],
                    processName: appData.name,
                    start: Date.now(),
                };
                const realGames = RunningGameStore.getRunningGames();
                const fakeGames = [fakeGame] as unknown as ReturnType<typeof RunningGameStore.getRunningGames>;
                const realGetRunningGames = RunningGameStore.getRunningGames;
                const realGetGameForPID = RunningGameStore.getGameForPID;
                RunningGameStore.getRunningGames = () => fakeGames;
                RunningGameStore.getGameForPID = (pid: number) => fakeGames.find(game => game.pid === pid) ?? null;
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: fakeGames });

                const listener = (data: { userStatus: { streamProgressSeconds: number; progress: Record<string, { value: number; }>; }; }) => {
                    const progress = quest.config.configVersion === 1 ? data.userStatus.streamProgressSeconds : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);
                    if (progress >= secondsNeeded) {
                        notify("Quest completed!", `${applicationName} - quest was successfully completed.`);

                        RunningGameStore.getRunningGames = realGetRunningGames;
                        RunningGameStore.getGameForPID = realGetGameForPID;
                        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                        FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

                        doJob().catch(reportError);
                    }
                };
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

                notify(`Spoofed your game to: ${applicationName}.`, `Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`, { variant: "info" });
            })
                .catch(error => reportError(new Error(`Could not set up game spoof for ${applicationName}: ${describeError(error)}`)));
        };

        const streamOnDesktopQuest = () => {
            if (!isApp) {
                notify(`Use the desktop app to complete the ${applicationName} quest!`, "This no longer works in browser for non-video quests.");
                return;
            }
            const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
            StreamMetadataUtils.getStreamerActiveStreamMetadata = () => ({
                id: applicationId,
                pid,
                sourceName: null
            });

            const listener = (data: { userStatus: { streamProgressSeconds: number; progress: Record<string, { value: number; }>; }; }) => {
                const progress = quest.config.configVersion === 1 ? data.userStatus.streamProgressSeconds : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
                if (progress >= secondsNeeded) {
                    notify("Quest completed!", `${questName} - quest was successfully completed.`, { variant: "success" });

                    StreamMetadataUtils.getStreamerActiveStreamMetadata = realFunc;
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

                    doJob().catch(reportError);
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

            notify(`Spoofed your stream to ${applicationName}. Stream any window in voice channel for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`, "Remember that you need at least 1 other person to be in the voice channel!", { variant: "info" });
        };

        const playActivityQuest = async () => {
            const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find(guild => guild != null && guild.VOCAL.length > 0)?.VOCAL[0].channel.id;
            if (!channelId) {
                notify(`Use the desktop app to complete the ${applicationName} quest!`, "Could not find a voice channel to spoof activity in.");
                return;
            }
            const streamKey = `call:${channelId}:1`;

            notify(`Completing quest: ${applicationName} - ${questName}`, "Sending activity heartbeats...", { variant: "info" });

            while (true) {
                const res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
                const progress = res.body.progress.PLAY_ACTIVITY.value;

                await new Promise(resolve => setTimeout(resolve, 20 * 1000));

                if (progress >= secondsNeeded) {
                    await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                    break;
                }
            }

            notify("Quest completed!", `${questName} - quest was successfully completed.`, { variant: "success" });
            doJob().catch(reportError);
        };

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                await videoQuest();
                break;
            case "PLAY_ON_DESKTOP":
                playOnDesktopQuest();
                break;
            case "STREAM_ON_DESKTOP":
                streamOnDesktopQuest();
                break;
            case "PLAY_ACTIVITY":
                await playActivityQuest();
                break;
        }
    };
    await doJob();
}

const QuestButton: ChatBarButtonFactory = () => (
    <ChatBarButton
        tooltip="Better Quest Completer"
        onClick={runQuestLogic}
    >
        <QuestIcon width={20} height={20} />
    </ChatBarButton>
);

export default definePlugin({
    name: "BetterQuestCompleter",
    permissions: [{
        id: "questCompletionSpoofing",
        title: "Simulate game/activity presence to complete quests",
        description: "Spoofs running games, video watch progress and activity streams so Discord marks quests complete without playing.",
        risk: "This is against Discord's terms of service and may result in quest rewards being revoked or account action."
    }],
    description: "Automatically completes supported Discord quests by simulating the required activity types.\nPorted from k4g9/discord-quest-completer",
    tags: ["Utility", "Fun"],
    authors: [Devs.Limey, Devs.k4g9],
    toolboxActions: {
        "Run Quests": runQuestLogic
    },

    chatBarButton: {
        icon: QuestIcon,
        render: QuestButton
    },
});

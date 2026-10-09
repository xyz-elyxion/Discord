/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Ported from k4g9/discord-quest-completer (MIT), "Better Quest Completer"
 * https://github.com/k4g9/discord-quest-completer
 * Rewritten to use Limey V1's webpack/REST/Notifications APIs instead of the
 * upstream's raw webpackChunkdiscord_app access.
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { showNotification } from "@api/Notifications";
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

import { type Quest, QuestTaskType } from "../questify/utils/types";

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

function notify(title: string, body: string) {
    showNotification({ title, body, dismissOnClick: false });
}

async function runQuestLogic() {
    const quests = [...QuestStore.quests.values()]
        .filter(quest =>
            quest.userStatus?.enrolledAt
            && !quest.userStatus?.completedAt
            && new Date(quest.config.expiresAt).getTime() > Date.now()
            && supportedTasks.find(task => Object.keys(quest.config.taskConfigV2.tasks).includes(task))
        );

    if (quests.length === 0) {
        notify("You don't have any uncompleted quests!", "Please make sure you have a quest selected.");
        return;
    }

    const doJob = () => {
        const quest = quests.pop();
        if (!quest) return;

        const pid = Math.floor(Math.random() * 30000) + 1000;
        const applicationId = quest.config.application.id;
        const applicationName = quest.config.application.name;
        const questName = quest.config.messages.questName;
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
                    const res = await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) } });
                    completed = res.body.completed_at != null;
                    secondsDone = Math.min(secondsNeeded, timestamp);
                }

                if (timestamp >= secondsNeeded) break;
                await new Promise(resolve => setTimeout(resolve, interval * 1000));
            }
            if (!completed) {
                await RestAPI.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
            }
            notify("Quest completed!", `${questName} - quest was successfully completed.`);
            doJob();
        };
        notify(`Spoofing video for: ${questName}.`, "❤️ Better Quest Completer");
        videoQuest();

        const playOnDesktopQuest = () => {
            if (!isApp) {
                notify(`Use the desktop app to complete the: ${applicationName} quest!`, "This no longer works in browser for non-video quests.");
                return;
            }
            RestAPI.get({ url: `/applications/public`, query: { application_ids: applicationId } }).then(res => {
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

                        doJob();
                    }
                };
                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

                notify(`Spoofed your game to: ${applicationName}.`, `Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
            });
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
                    notify("Quest completed!", `${questName} - quest was successfully completed.`);

                    StreamMetadataUtils.getStreamerActiveStreamMetadata = realFunc;
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

                    doJob();
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", listener);

            notify(`Spoofed your stream to ${applicationName}. Stream any window in voice channel for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`, "Remember that you need at least 1 other person to be in the voice channel!");
        };

        const playActivityQuest = async () => {
            const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find(guild => guild != null && guild.VOCAL.length > 0)?.VOCAL[0].channel.id;
            if (!channelId) {
                notify(`Use the desktop app to complete the ${applicationName} quest!`, "Could not find a voice channel to spoof activity in.");
                return;
            }
            const streamKey = `call:${channelId}:1`;

            notify(`Completing quest: ${applicationName} - ${questName}`, "❤️ Better Quest Completer");

            while (true) {
                const res = await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
                const progress = res.body.progress.PLAY_ACTIVITY.value;

                await new Promise(resolve => setTimeout(resolve, 20 * 1000));

                if (progress >= secondsNeeded) {
                    await RestAPI.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                    break;
                }
            }

            notify("Quest completed!", `${questName} - quest was successfully completed.`);
            doJob();
        };

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                videoQuest();
                break;
            case "PLAY_ON_DESKTOP":
                playOnDesktopQuest();
                break;
            case "STREAM_ON_DESKTOP":
                streamOnDesktopQuest();
                break;
            case "PLAY_ACTIVITY":
                playActivityQuest();
                break;
        }
    };
    doJob();
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
    authors: [Devs.Limey, { name: "k4g9 - github.com/k4g9", id: 848987722751410206n }],
    toolboxActions: {
        "Run Quests": runQuestLogic
    },

    chatBarButton: {
        icon: QuestIcon,
        render: QuestButton
    },
});

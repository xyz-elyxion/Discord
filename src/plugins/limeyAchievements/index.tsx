/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { VoiceState } from "@limeyV1/discord-types";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { GuildStore, Modal, openModal, SelectedChannelStore, showToast, Toasts, useEffect, UserStore,useState } from "@webpack/common";

import {
    Achievement,
    achievementPercent,
    ACHIEVEMENTS,
    formatNumber,
    LEVEL_CAP,
    levelProgress,
    statValue,
    titleForLevel,
    totalXp,
} from "./achievements";
import {
    AchievementState,
    addVoiceMinutes,
    flushAchievements,
    getAchievementState,
    loadAchievements,
    markActiveDay,
    onAchievementUnlocked,
    recordGuildCount,
    resetAchievements,
    subscribeToAchievements,
    trackMessage,
    unlockedCount,
} from "./store";

const settings = definePluginSettings({
    showBadge: {
        type: OptionType.BOOLEAN,
        description: "Show your Limey level badge on your own profile",
        default: true,
    },
    showProfileSection: {
        type: OptionType.BOOLEAN,
        description: "Show the achievements section on your own profile",
        default: true,
    },
    notifyOnUnlock: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when you unlock an achievement",
        default: true,
    },
});

let voiceSessionStart: number | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeUnlocks: (() => void) | null = null;

function useAchievementState(): AchievementState {
    const [snapshot, setSnapshot] = useState(getAchievementState);

    useEffect(() => subscribeToAchievements(() => setSnapshot(getAchievementState())), []);

    return snapshot;
}

function accrueVoiceMinutes() {
    if (voiceSessionStart == null) return;

    const minutes = Math.floor((Date.now() - voiceSessionStart) / 60_000);
    if (minutes < 1) return;

    voiceSessionStart += minutes * 60_000;
    addVoiceMinutes(minutes);
}

function beginVoiceSession() {
    if (voiceSessionStart == null) voiceSessionStart = Date.now();
}

function endVoiceSession() {
    accrueVoiceMinutes();
    voiceSessionStart = null;
}

function syncGuildCount() {
    const guilds = GuildStore?.getGuilds?.();
    if (guilds) recordGuildCount(Object.keys(guilds).length);
}

function ProgressBar({ percent }: { percent: number; }) {
    return (
        <div style={{
            height: 4,
            marginTop: 4,
            borderRadius: 2,
            overflow: "hidden",
            background: "var(--background-modifier-accent)",
        }}>
            <div style={{
                width: `${percent}%`,
                height: "100%",
                background: "var(--brand-500)",
            }} />
        </div>
    );
}

function LevelBadge() {
    const state = useAchievementState();
    const { level } = levelProgress(totalXp(state.stats, unlockedCount(state)));

    return (
        <span
            title={`Limey level ${level} · ${titleForLevel(level)}`}
            style={{ fontSize: 12, fontWeight: 600, color: "var(--text-strong)" }}
        >
            🍋{level}
        </span>
    );
}

function AchievementRow({ achievement, state }: { achievement: Achievement; state: AchievementState; }) {
    const done = Boolean(state.unlocked[achievement.id]);
    const percent = achievementPercent(achievement, state.stats);

    return (
        <div style={{ display: "flex", gap: 10 }}>
            <span style={{
                fontSize: 18,
                lineHeight: "22px",
                opacity: done ? 1 : 0.45,
                filter: done ? undefined : "grayscale(1)",
            }}>
                {achievement.icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <BaseText size="sm" weight="semibold">{achievement.name}</BaseText>
                    <span style={{ color: done ? "var(--text-positive)" : "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                        {done
                            ? "Unlocked"
                            : `${formatNumber(statValue(achievement, state.stats))} / ${formatNumber(achievement.goal)}`}
                    </span>
                </div>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{achievement.description}</span>
                {!done && <ProgressBar percent={percent} />}
            </div>
        </div>
    );
}

function AchievementsModal() {
    const state = useAchievementState();
    const [confirmingReset, setConfirmingReset] = useState(false);

    const unlockedTotal = unlockedCount(state);
    const progress = levelProgress(totalXp(state.stats, unlockedTotal));

    const sorted = [...ACHIEVEMENTS].sort((a, b) => {
        const aDone = Boolean(state.unlocked[a.id]);
        const bDone = Boolean(state.unlocked[b.id]);
        if (aDone !== bDone) return aDone ? -1 : 1;
        return achievementPercent(b, state.stats) - achievementPercent(a, state.stats);
    });

    async function handleReset() {
        if (!confirmingReset) {
            setConfirmingReset(true);
            return;
        }

        setConfirmingReset(false);
        await resetAchievements();
        showToast("Limey achievements reset", Toasts.Type.SUCCESS);
    }

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <BaseText size="sm" weight="semibold">
                        Level {progress.level} · {titleForLevel(progress.level)}
                    </BaseText>
                    <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        {unlockedTotal} / {ACHIEVEMENTS.length} unlocked
                    </span>
                </div>
                <ProgressBar percent={progress.percent} />
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {progress.level >= LEVEL_CAP
                        ? "Max level reached"
                        : `${formatNumber(progress.into)} / ${formatNumber(progress.needed)} XP to level ${progress.level + 1}`}
                </span>
            </div>

            <div style={{
                display: "flex",
                flexDirection: "column",
                gap: 14,
                maxHeight: 380,
                overflowY: "auto",
                paddingRight: 4,
            }}>
                {sorted.map(achievement => (
                    <AchievementRow key={achievement.id} achievement={achievement} state={state} />
                ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    Tracked locally on this device, never uploaded.
                </span>
                <span
                    role="button"
                    onClick={handleReset}
                    style={{
                        color: confirmingReset ? "var(--text-danger)" : "var(--text-link)",
                        fontSize: 12,
                        cursor: "pointer",
                    }}
                >
                    {confirmingReset ? "Click again to reset" : "Reset progress"}
                </span>
            </div>
        </div>
    );
}

function openAchievementsModal() {
    openModal(props => (
        <Modal
            {...props}
            title="🍋 Limey Achievements"
            subtitle="Everything here is tracked on this device only"
        >
            <AchievementsModal />
        </Modal>
    ));
}

function AchievementsSection({ userId, isSideBar }: { userId: string; isSideBar: boolean; }) {
    const state = useAchievementState();

    if (!settings.store.showProfileSection) return null;

    const myId = UserStore.getCurrentUser()?.id;
    if (!myId || userId !== myId) return null;

    const unlockedTotal = unlockedCount(state);
    const progress = levelProgress(totalXp(state.stats, unlockedTotal));

    return (
        <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <BaseText size={isSideBar ? "xs" : "sm"} weight="semibold">
                    🍋 Level {progress.level} · {titleForLevel(progress.level)}
                </BaseText>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {unlockedTotal}/{ACHIEVEMENTS.length}
                </span>
            </div>
            <ProgressBar percent={progress.percent} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {progress.level >= LEVEL_CAP
                        ? "Max level reached"
                        : `${formatNumber(progress.into)} / ${formatNumber(progress.needed)} XP`}
                </span>
                <span
                    role="button"
                    onClick={openAchievementsModal}
                    style={{ color: "var(--text-link)", fontSize: 12, cursor: "pointer" }}
                >
                    View all
                </span>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "LimeyAchievements",
    permissions: [
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Keeps your message, voice, server and daily activity counters in the client's local DataStore.",
            risk: "The counters persist on your device between sessions until you reset them from the achievements menu."
        },
        {
            id: "readMessages",
            title: "Read outgoing message content",
            description: "Reads the length of messages you send so character count and time-of-day achievements can be tracked. The text itself is never stored or sent anywhere.",
            risk: "Message text passes through the plugin when you send it."
        }
    ],
    description: "Local achievements and a Limey level for your own activity: messages, voice time, servers, daily streaks and more. Your level shows on your profile.",
    tags: ["Fun", "Utility"],
    authors: [Devs.Limey],
    dependencies: ["ProfileSectionsAPI"],
    settings,

    userProfileBadge: {
        id: "limey-achievements",
        key: "limeyAchievements",
        description: "Limey level",
        component: LevelBadge,
        shouldShow: ({ userId }) => settings.store.showBadge && userId === UserStore.getCurrentUser()?.id,
    },

    renderProfileSection: {
        render: AchievementsSection,
        priority: 0,
    },

    toolboxActions: {
        "Achievements": openAchievementsModal,
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: VoiceState[]; }) {
            const myId = UserStore.getCurrentUser()?.id;
            if (!myId) return;

            for (const state of voiceStates) {
                if (state.userId !== myId) continue;
                if (state.channelId) beginVoiceSession();
                else endVoiceSession();
            }
        },
        GUILD_CREATE() {
            syncGuildCount();
        },
        GUILD_DELETE() {
            syncGuildCount();
        },
    },

    onBeforeMessageSend(_channelId, messageObj) {
        trackMessage(messageObj.content ?? "");
    },

    async start() {
        unsubscribeUnlocks = onAchievementUnlocked(achievement => {
            if (!settings.store.notifyOnUnlock) return;
            showToast(`🏆 Achievement unlocked: ${achievement.name}`, Toasts.Type.SUCCESS);
        });

        await loadAchievements();
        markActiveDay();
        syncGuildCount();

        if (SelectedChannelStore.getVoiceChannelId?.()) beginVoiceSession();

        tickTimer = setInterval(() => {
            accrueVoiceMinutes();
            syncGuildCount();
        }, 60_000);
    },

    async stop() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }

        endVoiceSession();
        await flushAchievements();

        unsubscribeUnlocks?.();
        unsubscribeUnlocks = null;
    },
});

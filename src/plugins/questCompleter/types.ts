/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Types ported from https://github.com/aiko-chan-ai/Discord-Quest-Auto-Completion-Selfbot
// (see https://docs.discord.food/resources/quests for the upstream API docs)

export type Snowflake = string;

export type QuestTaskConfigType =
    | "STREAM_ON_DESKTOP"
    | "PLAY_ON_DESKTOP"
    | "PLAY_ON_DESKTOP_V2"
    | "PLAY_ON_XBOX"
    | "PLAY_ON_PLAYSTATION"
    | "WATCH_VIDEO"
    | "WATCH_VIDEO_ON_MOBILE"
    | "PLAY_ACTIVITY"
    | "ACHIEVEMENT_IN_GAME"
    | "ACHIEVEMENT_IN_ACTIVITY";

export interface QuestTask {
    type: QuestTaskConfigType;
    target: number;
}

export interface QuestApplication {
    id: Snowflake;
    name: string;
    link: string;
}

export interface QuestMessages {
    quest_name: string;
    game_title: string;
    game_publisher: string;
}

export interface QuestRewardsConfig {
    platforms: number[];
}

export interface QuestConfig {
    id: Snowflake;
    starts_at: string;
    expires_at: string;
    application: QuestApplication;
    messages: QuestMessages;
    rewards_config: QuestRewardsConfig;
    task_config_v2: {
        tasks: Partial<Record<QuestTaskConfigType, QuestTask>>;
    };
}

export interface QuestTaskProgress {
    event_name: string;
    value: number;
    updated_at: string;
    completed_at: string | null;
}

export interface QuestUserStatus {
    user_id: Snowflake;
    enrolled_at: string | null;
    completed_at: string | null;
    claimed_at: string | null;
    progress?: Record<string, QuestTaskProgress>;
}

export interface Quest {
    id: Snowflake;
    config: QuestConfig;
    user_status: QuestUserStatus | null;
    preview: boolean;
    traffic_metadata_raw?: string;
    traffic_metadata_sealed?: string;
}

export interface AllQuestsResponse {
    quests: Quest[];
    excluded_quests: Partial<Quest>[];
    quest_enrollment_blocked_until: string | null;
}

export interface OAuthTokenInfo {
    id: string;
    application: {
        id: Snowflake;
    };
}

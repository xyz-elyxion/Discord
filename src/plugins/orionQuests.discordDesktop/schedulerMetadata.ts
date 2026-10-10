/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { TaskType } from "./types";

export type SchedulerLane = "game" | "video";
export type SchedulerQuestState = "running" | "waiting";

/** Single source of truth for the lane a detected task type enters. */
export function schedulerLaneForTaskType(taskType: TaskType): SchedulerLane {
    return taskType === "WATCH_VIDEO" ? "video" : "game";
}

export interface SchedulerTaskView {
    questId: string;
    lane: SchedulerLane;
    active: boolean;
    started: boolean;
}

export interface SchedulerLaneSnapshot {
    /** Effective limit of the live batch in this lane; null when no batch is active. */
    readonly limit: number | null;
    readonly running: number;
    readonly waiting: number;
}

export interface SchedulerQuestSnapshot {
    readonly lane: SchedulerLane;
    readonly state: SchedulerQuestState;
}

export interface SchedulerSnapshot {
    readonly lanes: Readonly<Record<SchedulerLane, SchedulerLaneSnapshot>>;
    /** Only quests owned by a live scheduler batch appear here. No ordering is implied. */
    readonly quests: Readonly<Record<string, SchedulerQuestSnapshot>>;
}

type LaneRuntime = {
    token: number | null;
    limit: number | null;
};

function idleLane(): LaneRuntime {
    return { token: null, limit: null };
}

/**
 * Tracks only facts owned by the current scheduler batch. Queue order is deliberately absent:
 * Orion rebuilds its lanes every cycle and the next starter depends on timing and Promise.race,
 * so exposing an index would turn an implementation accident into a false contract.
 */
export class SchedulerMetadata {
    private nextToken = 0;
    private readonly lanes: Record<SchedulerLane, LaneRuntime> = {
        game: idleLane(),
        video: idleLane(),
    };
    private readonly listeners = new Set<() => void>();
    private deliveryQueued = false;

    beginLane(lane: SchedulerLane, limit: number): number {
        const token = ++this.nextToken;
        this.lanes[lane] = { token, limit: Math.max(1, limit) };
        this.emit();
        return token;
    }

    endLane(lane: SchedulerLane, token: number): void {
        if (this.lanes[lane].token !== token) return;
        this.lanes[lane] = idleLane();
        this.emit();
    }

    /** Invalidate every current batch token so a stale run cannot clear a replacement run. */
    clear(): void {
        const changed = this.lanes.game.token != null || this.lanes.video.token != null;
        this.lanes.game = idleLane();
        this.lanes.video = idleLane();
        if (changed) this.emit();
    }

    /** Publish a control-state transition only while at least one scheduler lane is live. */
    notify(): void {
        if (this.lanes.game.token == null && this.lanes.video.token == null) return;
        this.emit();
    }

    snapshot(tasks: Iterable<SchedulerTaskView>): SchedulerSnapshot {
        const game = { limit: this.lanes.game.limit, running: 0, waiting: 0 };
        const video = { limit: this.lanes.video.limit, running: 0, waiting: 0 };
        const quests: Record<string, SchedulerQuestSnapshot> = {};

        for (const task of tasks) {
            if (!task.active || this.lanes[task.lane].token == null || quests[task.questId]) continue;
            const state: SchedulerQuestState = task.started ? "running" : "waiting";
            quests[task.questId] = Object.freeze({ lane: task.lane, state });
            const lane = task.lane === "game" ? game : video;
            if (state === "running") lane.running++;
            else lane.waiting++;
        }

        return Object.freeze({
            lanes: Object.freeze({
                game: Object.freeze(game),
                video: Object.freeze(video),
            }),
            quests: Object.freeze(quests),
        });
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.listeners.delete(listener);
        };
    }

    private emit(): void {
        // State subscriptions are observational. Coalescing same-turn transitions avoids exposing
        // half-committed scheduler state and prevents a companion from synchronously re-entering
        // Start/Stop/Pause while the producer is changing a lane.
        if (this.deliveryQueued) return;
        this.deliveryQueued = true;
        queueMicrotask(() => {
            this.deliveryQueued = false;
            for (const listener of Array.from(this.listeners)) {
                try {
                    listener();
                } catch (error) {
                    console.error("[OrionQuests] Scheduler-state listener threw:", error);
                }
            }
        });
    }
}

export const schedulerMetadata = new SchedulerMetadata();

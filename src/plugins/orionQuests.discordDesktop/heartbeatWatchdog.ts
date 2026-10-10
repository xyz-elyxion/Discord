/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Why a task stopped waiting: one console line, and a short reason for the dashboard row. */
export interface WatchdogVerdict {
    message: string;
    reason: string;
}

export interface HeartbeatWatchdogOptions {
    questName: string;
    /** How long a task waits with no dispatch at all before it gives up. */
    graceMs: number;
    /** Consecutive failed beats that end the task. */
    maxConsecutiveFailures: number;
    setTimer: (fn: () => void, ms: number) => number;
    clearTimer: (id: number) => void;
    /** A failure that is not yet a verdict, for the debug log. */
    onFailureNoted: (message: string) => void;
    onGiveUp: (verdict: WatchdogVerdict) => void;
}

/**
 * Decides when a `PLAY_ON_DESKTOP` / `STREAM_ON_DESKTOP` task has waited long enough.
 *
 * Orion sends nothing once the spoof is installed: Discord drives the heartbeats and Orion reads
 * `QUESTS_SEND_HEARTBEAT_SUCCESS` / `_FAILURE` off the dispatcher. Discord's cadence is a flat
 * 60s (`QuestProgressManager.calculateHeartbeatDurationMs` returns `Millis.MINUTE` until under a
 * minute of the target remains) and it does not retry a failed beat: the sender dispatches the
 * failure and the next attempt is the tick already scheduled 60s out.
 *
 * The engine used to rearm its 90s watchdog only on a success, so one failed beat ended the task
 * 30 seconds before Discord would have recovered it, reported as "Discord stopped reporting
 * progress" when Discord had actually answered with an error. It also meant the consecutive
 * failure limit could never be reached on these two task types, because a second failure needs
 * 120s and the watchdog fired at 90, so the branch that names Discord's own status code never
 * ran for a game quest. That is issue #74.
 *
 * A failure therefore rearms the watchdog too, and `maxConsecutiveFailures` is what gives up.
 * The exception is a failure before any credited beat: that keeps the original deadline, because
 * the "Discord is not accepting the injected process" message is the answer to issue #43 and is
 * worth a beat and a half rather than five minutes of retries.
 */
export class HeartbeatWatchdog {
    private readonly options: HeartbeatWatchdogOptions;
    private timer: number | null = null;
    private beatCount = 0;
    private failedBeats = 0;
    private consecutiveFailures = 0;
    private lastFailure: string | null = null;
    private settled = false;

    constructor(options: HeartbeatWatchdogOptions) {
        this.options = options;
    }

    /** Credited beats seen so far. */
    get beats(): number {
        return this.beatCount;
    }

    start(): void {
        this.arm();
    }

    /** A `QUESTS_SEND_HEARTBEAT_SUCCESS` for this quest. */
    beat(): void {
        if (this.settled) return;
        this.beatCount++;
        this.consecutiveFailures = 0;
        this.arm();
    }

    /** A `QUESTS_SEND_HEARTBEAT_FAILURE` for this quest, `why` already described. */
    fail(why: string): void {
        if (this.settled) return;
        this.failedBeats++;
        this.consecutiveFailures++;
        this.lastFailure = why;

        const { questName, maxConsecutiveFailures } = this.options;
        if (this.consecutiveFailures >= maxConsecutiveFailures) {
            this.giveUp({
                message: `[Task] Discord's heartbeat for "${questName}" failed ${this.consecutiveFailures} times in a row: ${why}. Giving up rather than waiting out the watchdog.`,
                reason: `Discord could not report progress (${why})`,
            });
            return;
        }

        this.options.onFailureNoted(
            `[Task] Discord's heartbeat for "${questName}" failed (${this.consecutiveFailures}/${maxConsecutiveFailures}): ${why}`,
        );

        // Nothing credited yet means the spoof itself is the suspect, so the first deadline
        // stands and the answer arrives quickly. After that, a failure is proof Discord is still
        // driving the quest and will try again on its next tick.
        if (this.beatCount > 0) this.arm();
    }

    /** Detach: no verdict can follow, and no timer is left behind. */
    stop(): void {
        this.settled = true;
        this.disarm();
    }

    private arm(): void {
        this.disarm();
        this.timer = this.options.setTimer(() => {
            this.timer = null;
            this.giveUp(this.silenceVerdict());
        }, this.options.graceMs);
    }

    private disarm(): void {
        if (this.timer != null) this.options.clearTimer(this.timer);
        this.timer = null;
    }

    private giveUp(verdict: WatchdogVerdict): void {
        if (this.settled) return;
        this.settled = true;
        this.disarm();
        this.options.onGiveUp(verdict);
    }

    private silenceVerdict(): WatchdogVerdict {
        const { questName } = this.options;
        const failed = this.failedBeats;
        const reason = failed > 0
            ? `No heartbeat from Discord (${failed} failed beat(s))`
            : "No heartbeat from Discord";

        if (this.beatCount === 0) {
            return {
                message: failed > 0
                    ? `[Task] Discord never reported progress for "${questName}". All ${failed} heartbeat(s) it tried failed, the last one ${this.lastFailure}.`
                    : `[Task] Discord never reported progress for "${questName}". It is not accepting the injected process on this client, so there is nothing to wait for.`,
                reason,
            };
        }

        const what = failed > 0
            ? `after ${this.beatCount} update(s) and ${failed} failed beat(s), the last one ${this.lastFailure}.`
            : `after ${this.beatCount} update(s).`;
        return {
            message: `[Task] Discord stopped reporting progress for "${questName}" ${what} Giving up instead of idling.`,
            reason,
        };
    }
}

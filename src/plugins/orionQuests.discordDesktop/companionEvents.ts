/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type CompanionEventLevel = "debug" | "info" | "success" | "warning" | "error";
export type CompanionEventCategory =
    | "startup"
    | "system"
    | "cycle"
    | "quest"
    | "enroll"
    | "task"
    | "claim"
    | "network"
    | "achievement"
    | "bypass"
    | "patcher";
export type CompanionEventStability = "stable" | "provisional";

/**
 * Stable codes describe semantic lifecycle facts Orion already treats as public behavior.
 * Provisional codes are diagnostic/cycle detail: consumers may display them, but should not make
 * control decisions from them until their semantics have settled through real companion use.
 */
export const COMPANION_EVENT_CODES = {
    ENGINE_STARTED: "engine.started",
    ENGINE_START_FAILED: "engine.start_failed",
    ENGINE_FAILED: "engine.failed",
    ENGINE_STOPPED: "engine.stopped",
    QUEST_BLOCKED: "quest.blocked",
    ENROLL_WAITING: "enroll.waiting",
    ENROLL_STARTED: "enroll.started",
    ENROLL_FAILED: "enroll.failed",
    TASK_STARTED: "task.started",
    TASK_COMPLETED: "task.completed",
    TASK_FAILED: "task.failed",
    CLAIM_SUCCEEDED: "claim.succeeded",
    CLAIM_ACTION_REQUIRED: "claim.action_required",
    CLAIM_FAILED: "claim.failed",
    NETWORK_RETRY: "network.retry",
    NETWORK_FAILED: "network.failed",
    HEARTBEAT_FAILURE: "heartbeat.failure",
    HEARTBEAT_GIVE_UP: "heartbeat.give_up",
    ACHIEVEMENT_FALLBACK: "achievement.fallback",
    BYPASS_STARTED: "bypass.started",
    BYPASS_SUCCEEDED: "bypass.succeeded",
    BYPASS_FAILED: "bypass.failed",
    STARTUP_QUEST_LIST_WAITING: "startup.quest_list_waiting",
    STARTUP_QUEST_LIST_ARRIVED: "startup.quest_list_arrived",
    STARTUP_QUEST_LIST_TIMEOUT: "startup.quest_list_timeout",
    CYCLE_STARTED: "cycle.started",
    CYCLE_PROCESSING: "cycle.processing",
    CYCLE_COMPLETED: "cycle.completed",
    CYCLE_FAILED: "cycle.failed",
    SYSTEM_ACCOUNT_CHANGED: "system.account_changed",
    SYSTEM_QUEST_ACCESS_SUSPENDED: "system.quest_access_suspended",
    SYSTEM_ENROLLMENT_BLOCKED: "system.enrollment_blocked",
    SYSTEM_QUEST_LIST_MISSING: "system.quest_list_missing",
    SYSTEM_RUN_SUMMARY: "system.run_summary",
    PATCHER_PRESENCE_RESTORED: "patcher.presence_restored",
    PATCHER_PRESENCE_RESTORE_FAILED: "patcher.presence_restore_failed",
} as const;

export type CompanionEventCode = typeof COMPANION_EVENT_CODES[keyof typeof COMPANION_EVENT_CODES];

export const COMPANION_EVENT_CODE_STABILITY: Readonly<Record<CompanionEventCode, CompanionEventStability>> = Object.freeze({
    [COMPANION_EVENT_CODES.ENGINE_STARTED]: "stable",
    [COMPANION_EVENT_CODES.ENGINE_START_FAILED]: "stable",
    [COMPANION_EVENT_CODES.ENGINE_FAILED]: "stable",
    [COMPANION_EVENT_CODES.ENGINE_STOPPED]: "stable",
    [COMPANION_EVENT_CODES.QUEST_BLOCKED]: "stable",
    [COMPANION_EVENT_CODES.ENROLL_WAITING]: "stable",
    [COMPANION_EVENT_CODES.ENROLL_STARTED]: "stable",
    [COMPANION_EVENT_CODES.ENROLL_FAILED]: "stable",
    [COMPANION_EVENT_CODES.TASK_STARTED]: "stable",
    [COMPANION_EVENT_CODES.TASK_COMPLETED]: "stable",
    [COMPANION_EVENT_CODES.TASK_FAILED]: "stable",
    [COMPANION_EVENT_CODES.CLAIM_SUCCEEDED]: "stable",
    [COMPANION_EVENT_CODES.CLAIM_ACTION_REQUIRED]: "stable",
    [COMPANION_EVENT_CODES.CLAIM_FAILED]: "stable",
    [COMPANION_EVENT_CODES.NETWORK_RETRY]: "stable",
    [COMPANION_EVENT_CODES.NETWORK_FAILED]: "stable",
    [COMPANION_EVENT_CODES.HEARTBEAT_FAILURE]: "stable",
    [COMPANION_EVENT_CODES.HEARTBEAT_GIVE_UP]: "stable",
    [COMPANION_EVENT_CODES.ACHIEVEMENT_FALLBACK]: "stable",
    [COMPANION_EVENT_CODES.BYPASS_STARTED]: "stable",
    [COMPANION_EVENT_CODES.BYPASS_SUCCEEDED]: "stable",
    [COMPANION_EVENT_CODES.BYPASS_FAILED]: "stable",
    [COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_WAITING]: "provisional",
    [COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_ARRIVED]: "provisional",
    [COMPANION_EVENT_CODES.STARTUP_QUEST_LIST_TIMEOUT]: "provisional",
    [COMPANION_EVENT_CODES.CYCLE_STARTED]: "provisional",
    [COMPANION_EVENT_CODES.CYCLE_PROCESSING]: "provisional",
    [COMPANION_EVENT_CODES.CYCLE_COMPLETED]: "provisional",
    [COMPANION_EVENT_CODES.CYCLE_FAILED]: "provisional",
    [COMPANION_EVENT_CODES.SYSTEM_ACCOUNT_CHANGED]: "provisional",
    [COMPANION_EVENT_CODES.SYSTEM_QUEST_ACCESS_SUSPENDED]: "provisional",
    [COMPANION_EVENT_CODES.SYSTEM_ENROLLMENT_BLOCKED]: "provisional",
    [COMPANION_EVENT_CODES.SYSTEM_QUEST_LIST_MISSING]: "provisional",
    [COMPANION_EVENT_CODES.SYSTEM_RUN_SUMMARY]: "provisional",
    [COMPANION_EVENT_CODES.PATCHER_PRESENCE_RESTORED]: "provisional",
    [COMPANION_EVENT_CODES.PATCHER_PRESENCE_RESTORE_FAILED]: "provisional",
});

export interface CompanionEventFailure {
    /** No more retry/fallback remains for the operation represented by this event. */
    readonly terminal: boolean;
    /** The underlying failure class permits retry, even if this event is the exhausted terminal one. */
    readonly retryable: boolean;
    /** 1-based operation attempt when Orion has a meaningful counter; otherwise null. */
    readonly attempt: number | null;
    readonly maxAttempts: number | null;
    readonly httpStatus: number | null;
    readonly upstreamCode: string | number | null;
    readonly reason: string | null;
}

export interface CompanionFailureInput {
    terminal: boolean;
    retryable: boolean;
    attempt?: number | null;
    maxAttempts?: number | null;
    httpStatus?: number | null;
    upstreamCode?: string | number | null;
    reason?: string | null;
}

export interface CompanionEvent {
    readonly timestamp: number;
    readonly code: CompanionEventCode;
    readonly category: CompanionEventCategory;
    readonly level: CompanionEventLevel;
    /** Human context only. Consumers must use code/fields, not parse this string for meaning. */
    readonly message: string;
    readonly questId?: string;
    readonly questName?: string;
    readonly taskType?: string;
    /** Structured non-failure reason, for example why a quest was deliberately skipped. */
    readonly reason?: string;
    readonly failure?: CompanionEventFailure;
}

export type CompanionEventInput = Omit<CompanionEvent, "timestamp"> & { timestamp?: number; };
export type CompanionEventListener = (event: CompanionEvent) => void;

const eventListeners = new Set<CompanionEventListener>();

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    // JSON/stringified error objects need their own forms because the quote after the key means
    // a plain `key: value` pattern never reaches the colon.
    [/(\[?\s*["']authorization["']\s*:\s*["'])(?:bearer\s+)?[^"']*(["'])/gi, "$1[REDACTED]$2"],
    [/(\[?\s*["'](?:access[_-]?token|auth[_-]?token|proxy[_-]?ticket|discord_proxy_ticket|cookie|oauth[_-]?code|auth[_-]?code|token|ticket)["']\s*:\s*["'])[^"']*(["'])/gi, "$1[REDACTED]$2"],
    [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1[REDACTED]"],
    [/(access[_-]?token|auth[_-]?token|proxy[_-]?ticket|discord_proxy_ticket|cookie|token|ticket)\s*[:=]\s*[^\s,;&]+/gi, "$1=[REDACTED]"],
    [/(oauth(?:[_\s-]?code)|auth(?:[_\s-]?code))\s*[:=]\s*[^\s,;&]+/gi, "$1=[REDACTED]"],
    [/([?&](?:code|auth_code|oauth_code|token|access_token|auth_token|ticket|proxy_ticket|discord_proxy_ticket)=)[^&#\s]+/gi, "$1[REDACTED]"],
];

/** Defense-in-depth at the producer boundary: companions never receive known credential shapes. */
export function sanitizeCompanionText(value: string): string {
    let text = value;
    for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
    return text;
}

function finitePositiveInteger(value: number | null | undefined): number | null {
    if (value == null || !Number.isFinite(value)) return null;
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
}

function finiteHttpStatus(value: number | null | undefined): number | null {
    const normalized = finitePositiveInteger(value);
    return normalized != null && normalized >= 100 && normalized <= 599 ? normalized : null;
}

export function companionFailure(input: CompanionFailureInput): CompanionEventFailure {
    const attempt = finitePositiveInteger(input.attempt);
    let maxAttempts = finitePositiveInteger(input.maxAttempts);
    // Do not publish an impossible counter pair. Null is preferable to inventing a larger budget
    // when a producer supplied maxAttempts smaller than the attempt that actually occurred.
    if (attempt != null && maxAttempts != null && maxAttempts < attempt) maxAttempts = null;

    return Object.freeze({
        terminal: input.terminal,
        retryable: input.retryable,
        attempt,
        maxAttempts,
        httpStatus: finiteHttpStatus(input.httpStatus),
        upstreamCode: typeof input.upstreamCode === "string"
            ? sanitizeCompanionText(input.upstreamCode)
            : typeof input.upstreamCode === "number" ? input.upstreamCode : null,
        reason: typeof input.reason === "string" && input.reason.length > 0
            ? sanitizeCompanionText(input.reason)
            : null,
    });
}

export function subscribeCompanionEvents(listener: CompanionEventListener): () => void {
    eventListeners.add(listener);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        eventListeners.delete(listener);
    };
}

export function emitCompanionEvent(input: CompanionEventInput): void {
    // task.failed is the terminal task-generation boundary. Keep its failure shape total even for
    // local failures such as timeouts/no-channel cases that have no HTTP metadata to contribute.
    const sourceFailure = input.failure ?? (input.code === COMPANION_EVENT_CODES.TASK_FAILED
        ? companionFailure({ terminal: true, retryable: false, reason: input.reason ?? null })
        : undefined);
    // Normalize again at the delivery boundary so a future producer cannot bypass counter/status
    // validation by constructing a CompanionEventFailure object directly instead of using the
    // helper above.
    const failure = sourceFailure ? companionFailure(sourceFailure) : undefined;
    const event = Object.freeze({
        ...input,
        message: sanitizeCompanionText(input.message),
        ...(input.reason ? { reason: sanitizeCompanionText(input.reason) } : {}),
        timestamp: Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now(),
        ...(failure ? { failure } : {}),
    }) as CompanionEvent;

    // Capture subscribers at the emission boundary, then deliver on the next microtask. Events
    // stay FIFO, and unsubscribe still affects only later emissions, but an observer cannot
    // synchronously re-enter Stop/Pause in the middle of the engine transition it is observing.
    // That keeps this API observational rather than turning it into an accidental pre-action hook.
    const listeners = Array.from(eventListeners);
    queueMicrotask(() => {
        for (const listener of listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error("[OrionQuests] Companion event listener threw:", error);
            }
        }
    });
}

/** Test-only lifecycle helper; production subscribers own their unsubscribe callbacks. */
export function clearCompanionEventListeners(): void {
    eventListeners.clear();
}

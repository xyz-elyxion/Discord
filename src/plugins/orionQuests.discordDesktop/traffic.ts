/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { COMPANION_EVENT_CODES, companionFailure, emitCompanionEvent } from "./companionEvents";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const rnd = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * The engine's logger, injected rather than imported: this module stays free of Vencord
 * aliases so `tests/traffic.test.ts` runs under plain `node --test` without a Vencord checkout.
 */
export interface TrafficLogger {
    warn(...args: any[]): void;
    error(...args: any[]): void;
    debug(...args: any[]): void;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 408]);
const CLIENT_ERRORS = new Set([400, 403, 404, 409, 410]);
const MAX_RETRIES = 3;
const MAX_ATTEMPTS = MAX_RETRIES + 1;

type RequestPhase = "queued" | "inflight" | "backoff" | "settled";

interface QueuedRequest {
    url: string;
    body: unknown;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    /** Retries already scheduled; the actual request attempt is attempts + 1. */
    attempts: number;
    isActive: () => boolean;
    signal?: AbortSignal;
    abortListener?: () => void;
    retryTimer?: ReturnType<typeof setTimeout>;
    phase: RequestPhase;
}

interface ClassifiedError {
    isRetryable: boolean;
    isClientError: boolean;
    status: number | undefined;
    upstreamCode: string | number | null;
    message: string;
}

function classify(error: any): ClassifiedError {
    const status = error?.status ?? error?.statusCode;
    const rawCode = error?.body?.code ?? error?.code;
    return {
        isRetryable: RETRYABLE.has(status),
        isClientError: CLIENT_ERRORS.has(status),
        status,
        upstreamCode: typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : null,
        message: error?.message ?? error?.body?.message ?? `HTTP ${status ?? "UNKNOWN"}`,
    };
}

function cancelledError(): Error {
    const error = new Error("Task cancelled");
    error.name = "AbortError";
    return error;
}

function questIdFromUrl(url: string): string | undefined {
    return url.match(/^\/quests\/(\d+)(?:\/|$)/)?.[1];
}

function emitNetworkRetry(req: QueuedRequest, err: ClassifiedError): void {
    const actualAttempt = req.attempts + 1;
    const statusText = err.status != null ? ` after HTTP ${err.status}` : "";
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.NETWORK_RETRY,
        category: "network",
        level: "warning",
        message: `Quest request attempt ${actualAttempt} failed${statusText}; Orion will retry.`,
        questId: questIdFromUrl(req.url),
        failure: companionFailure({
            terminal: false,
            retryable: true,
            attempt: actualAttempt,
            maxAttempts: MAX_ATTEMPTS,
            httpStatus: err.status,
            upstreamCode: err.upstreamCode,
            reason: err.message,
        }),
    });
}

function emitNetworkFailure(req: QueuedRequest, err: ClassifiedError): void {
    const actualAttempt = req.attempts + 1;
    const exhaustedRetry = err.isRetryable && req.attempts >= MAX_RETRIES;
    const statusText = err.status != null ? ` (HTTP ${err.status})` : "";
    emitCompanionEvent({
        code: COMPANION_EVENT_CODES.NETWORK_FAILED,
        category: "network",
        level: exhaustedRetry || !err.isClientError ? "error" : "warning",
        message: exhaustedRetry
            ? `Quest request failed after ${actualAttempt} attempts${statusText}.`
            : `Quest request failed${statusText}.`,
        questId: questIdFromUrl(req.url),
        failure: companionFailure({
            // This is terminal for this queued HTTP operation. The owning task may still choose a
            // fallback (for example ACHIEVEMENT heartbeat -> OAuth bypass), which is represented
            // separately by the task-level events rather than hidden in this request event.
            terminal: true,
            retryable: err.isRetryable,
            attempt: actualAttempt,
            // A non-retryable response may terminate a request after earlier retryable failures.
            // In that case the effective operation budget ended on this actual attempt; never
            // publish an impossible pair such as attempt=2,maxAttempts=1.
            maxAttempts: err.isRetryable ? MAX_ATTEMPTS : actualAttempt,
            httpStatus: err.status,
            upstreamCode: err.upstreamCode,
            reason: err.message,
        }),
    });
}

export function isSkippableQuest(error: any): boolean {
    const status = error?.status;
    return status === 404 || status === 403 || status === 410;
}

export class Traffic {
    private queue: QueuedRequest[] = [];
    private processing = false;
    private API: any;
    private isRunning: () => boolean;
    private log: TrafficLogger;

    constructor(API: any, isRunning: () => boolean, log: TrafficLogger) {
        this.API = API;
        this.isRunning = isRunning;
        this.log = log;
    }

    enqueue<T = any>(
        url: string,
        body: unknown,
        isActive: () => boolean = () => true,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.isRunning()) return Promise.reject(new Error("Stopped"));
        if (!isActive() || signal?.aborted) return Promise.reject(cancelledError());

        return new Promise<T>((resolve, reject) => {
            const req: QueuedRequest = {
                url,
                body,
                resolve,
                reject,
                attempts: 0,
                isActive,
                signal,
                phase: "queued",
            };

            if (signal) {
                req.abortListener = () => {
                    // RestAPI.post does not expose a safe abort handle. Once a request is on the
                    // wire, keep the task generation reserved until the real request settles.
                    if (req.phase === "inflight" || req.phase === "settled") return;
                    this.rejectCancelled(req);
                };
                signal.addEventListener("abort", req.abortListener, { once: true });
            }

            this.queue.push(req);
            this.process();
        });
    }

    private requestIsActive(req: QueuedRequest): boolean {
        return this.isRunning() && req.isActive() && !req.signal?.aborted;
    }

    private detachAbort(req: QueuedRequest): void {
        if (req.signal && req.abortListener) {
            req.signal.removeEventListener("abort", req.abortListener);
            req.abortListener = undefined;
        }
        if (req.retryTimer) {
            clearTimeout(req.retryTimer);
            req.retryTimer = undefined;
        }
    }

    private settleResolve(req: QueuedRequest, value: any): void {
        if (req.phase === "settled") return;
        req.phase = "settled";
        this.detachAbort(req);
        req.resolve(value);
    }

    private settleReject(req: QueuedRequest, reason: any): void {
        if (req.phase === "settled") return;
        req.phase = "settled";
        this.detachAbort(req);
        req.reject(reason);
    }

    private rejectCancelled(req: QueuedRequest): void {
        this.settleReject(req, this.isRunning() ? cancelledError() : new Error("Shutdown"));
    }

    private async process(): Promise<void> {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;

        while (this.queue.length > 0) {
            if (!this.isRunning()) {
                for (const req of this.queue) this.settleReject(req, new Error("Shutdown"));
                this.queue = [];
                this.processing = false;
                return;
            }

            const req = this.queue.shift()!;
            if (req.phase === "settled") continue;

            // A queued request belongs to the generation that enqueued it. Resume may create
            // a newer generation for the same quest, but the signal/predicate stay bound to the
            // old one and therefore can never become valid again.
            if (!this.requestIsActive(req)) {
                this.rejectCancelled(req);
                continue;
            }

            req.phase = "inflight";
            try {
                const res = await this.API.post({ url: req.url, body: req.body });
                // The request may already be on the wire when Pause happens. We cannot unsend it,
                // but its settled continuation must not publish progress or start later work.
                if (this.requestIsActive(req)) this.settleResolve(req, res);
                else this.rejectCancelled(req);
            } catch (e: any) {
                if (!this.requestIsActive(req)) {
                    this.rejectCancelled(req);
                    continue;
                }

                const err = classify(e);

                if (err.isRetryable && req.attempts < MAX_RETRIES) {
                    emitNetworkRetry(req, err);
                    req.attempts++;
                    const delay = (e.body?.retry_after ?? Math.pow(2, req.attempts)) * 1000;
                    const isGlobal = e.body?.global === true;
                    this.log.warn(`[Network] Retry ${req.attempts}/${MAX_RETRIES} in ${(delay / 1000).toFixed(1)}s (HTTP ${err.status})`);
                    const retryJitter = rnd(200, 800);
                    req.phase = "backoff";

                    if (isGlobal) {
                        // The request's promise can be cancelled immediately through its signal,
                        // while the shared global pacing delay still applies to unrelated work.
                        this.queue.unshift(req);
                        await sleep(delay + retryJitter);
                    } else {
                        req.retryTimer = setTimeout(() => {
                            req.retryTimer = undefined;
                            if (req.phase === "settled") return;
                            if (this.requestIsActive(req)) {
                                req.phase = "queued";
                                this.queue.push(req);
                                this.process();
                            } else {
                                this.rejectCancelled(req);
                            }
                        }, delay + retryJitter);
                    }
                } else if (err.isClientError) {
                    this.log.debug(`[Network] HTTP ${err.status}: ${req.url}`);
                    emitNetworkFailure(req, err);
                    this.settleReject(req, e);
                } else {
                    this.log.error(`[Network] Request to ${req.url} failed: ${err.message}`);
                    emitNetworkFailure(req, err);
                    this.settleReject(req, e);
                }
            }

            await sleep(rnd(1200, 1800));
        }
        this.processing = false;
    }
}

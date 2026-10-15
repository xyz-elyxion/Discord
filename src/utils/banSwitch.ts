/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Client-side enforcement of the Limey V1 ban list.
 *
 * At boot (after webpack sessions are ready, so the current user id is
 * readable) the client asks the Limey V1 backend whether the id is banned.
 * A banned boot keeps the mod inert — no further plugins start and anything
 * already started is stopped — and shows a small card explaining why.
 *
 * The result is cached for an hour so boots stay fast and the mod behaves the
 * same offline until the cache expires. A failed check is fail-open: recover
 * modes, outages and blocked networks simply leave the user alone.
 */

import { UserStore } from "@webpack/common";

export interface BanInfo {
    banned: boolean;
    reason?: string;
    bannedAt?: number | null;
}

const BAN_CHECK_URL = "https://limey-discord.onrender.com/v1/bans/check";
const CACHE_KEY = "LimeyV1BanCheck";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry extends BanInfo {
    userId: string;
    checkedAt: number;
}

function readCache(userId: string): CacheEntry | null {
    try {
        const raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CacheEntry;
        if (parsed?.userId !== userId || typeof parsed.checkedAt !== "number") return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeCache(userId: string, ban: BanInfo) {
    try {
        const entry: CacheEntry = { ...ban, userId, checkedAt: Date.now() };
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
    } catch {
        // storage unavailable — every boot just re-checks
    }
}

export async function checkCurrentBan(): Promise<BanInfo | null> {
    const userId = UserStore?.getCurrentUser?.()?.id;
    if (!userId) return null;

    const cached = readCache(String(userId));
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) return cached;

    let result: BanInfo | null = null;
    try {
        const res = await fetch(`${BAN_CHECK_URL}/${userId}`);
        if (res.ok) {
            const data = await res.json();
            result = {
                banned: data?.banned === true,
                reason: typeof data?.reason === "string" ? data.reason : "",
                bannedAt: typeof data?.bannedAt === "number" ? data.bannedAt : null
            };
        } else if (res.status === 429) {
            result = cached; // rate limited — trust the last known state
        }
    } catch {
        return cached;
    }
    if (!result) return cached;

    writeCache(String(userId), result);
    return result;
}

const BAN_NOTICE_ID = "vc-limey-ban-notice";

/**
 * Small red card shown whenever a banned boot gets past the gate. Rendered
 * with plain DOM like the "Limey off" notice — it must work while no copy of
 * Limey V1 UI is running.
 */
export function installBannedNotice(ban: BanInfo) {
    if (typeof document === "undefined" || document.getElementById(BAN_NOTICE_ID)) return;

    const mount = () => {
        if (document.getElementById(BAN_NOTICE_ID)) return;

        const card = document.createElement("div");
        card.id = BAN_NOTICE_ID;
        card.style.cssText = [
            "position: fixed",
            "bottom: 20px",
            "right: 20px",
            "z-index: 2147483646",
            " max-width: 340px",
            "padding: 14px 16px",
            "background: #1e1f22",
            "color: #dbdee1",
            "border: 1px solid #57333d",
            "border-left: 4px solid #ed4245",
            "border-radius: 8px",
            "box-shadow: 0 8px 24px rgba(0, 0, 0, .45)",
            "font: 500 13.5px/1.4 'gg sans', 'Noto Sans', system-ui, sans-serif"
        ].join(";");

        const title = document.createElement("div");
        title.textContent = "You've been banned from Limey V1.";
        title.style.cssText = "color:#f38ba0;font-weight:700;margin-bottom:4px";

        const body = document.createElement("div");
        const reason = ban?.reason ? ` Reason: ${ban.reason}.` : "";
        const since = ban?.bannedAt
            ? ` Banned ${new Date(ban.bannedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}.`
            : "";
        body.textContent = `Limey V1 stays disabled on this account.${reason}${since}`;

        const appeal = document.createElement("a");
        appeal.textContent = "Appeal in the Limey community";
        appeal.href = "https://discord.gg/n8rmQJRAzV";
        appeal.target = "_blank";
        appeal.rel = "noreferrer noopener";
        appeal.style.cssText = "display:inline-block;margin-top:8px;color:#dbdee1;text-decoration:underline;font-size:12.5px";

        card.append(title, body, appeal);
        document.body.appendChild(card);
    };

    if (document.body) {
        mount();
    } else {
        document.addEventListener("DOMContentLoaded", mount, { once: true });
    }
}

/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/** Where the link should point, as far as the caller knows about it. */
export interface ChannelContext {
    channelId: string;
    guildId?: string;
    messageId?: string;
}

export type LinkKind = "auto" | "channel" | "message" | "user" | "guild";

export const LINK_KINDS: LinkKind[] = ["auto", "channel", "message", "user", "guild"];

export type LinkResult =
    | { ok: true; link: string; path: string; }
    | { ok: false; error: string; };

const PROTOCOL = "discord://-/";

/** discord.com pages that exist only on the website and have no client route */
const WEB_ONLY_ROOTS = new Set([
    "api", "blog", "brand", "careers", "developers", "download", "guidelines",
    "jobs", "login", "nitro", "privacy", "register", "safety", "terms",
]);

const SNOWFLAKE = /^\d{15,21}$/;

function channelPath({ channelId, guildId, messageId }: ChannelContext) {
    const base = `/channels/${guildId || "@me"}/${channelId}`;
    return messageId ? `${base}/${messageId}` : base;
}

/** `https://ptb.discord.com/channels/1/2` -> `/channels/1/2` */
function stripHost(value: string) {
    const match = /^(?:https?:\/\/)?(?:[\w-]+\.)*(?:discord\.com|discordapp\.com)(?::\d+)?(\/.*)?$/i.exec(value);
    return match ? match[1] ?? "/" : null;
}

/** `https://discord.gg/abc` -> `/invite/abc` */
function stripInviteHost(value: string) {
    const match = /^(?:https?:\/\/)?(?:[\w-]+\.)*discord\.gg\/([\w-]+)\/?$/i.exec(value);
    return match ? `/invite/${match[1]}` : null;
}

/** `discord://-/channels/1/2` and `discord://discord.com/channels/1/2` -> `/channels/1/2` */
function stripProtocol(value: string) {
    const body = value.slice("discord://".length);
    if (body.startsWith("-/")) return body.slice(1);

    const slash = body.indexOf("/");
    return slash === -1 ? null : body.slice(slash);
}

function normalizePath(raw: string) {
    const path = raw.trim().split(/[?#]/)[0];
    if (!path.startsWith("/") || /\s/.test(path) || path.includes("..")) return null;

    const normalized = path.replace(/\/+$/, "") || "/";
    const root = normalized.split("/")[1]?.toLowerCase() ?? "";
    if (root && WEB_ONLY_ROOTS.has(root)) return null;

    return normalized;
}

/**
 * Builds a `discord://-/` link from a Discord URL, an existing protocol link, a bare ID, or
 * the current channel when `input` is empty.
 */
export function makeLink(input: string, context?: ChannelContext, kind: LinkKind = "auto"): LinkResult {
    const value = input.trim().replace(/^</, "").replace(/>$/, "");

    let path: string | null = null;

    if (!value) {
        if (!context?.channelId) return { ok: false, error: "Paste a Discord link, or run this in a channel to link to it." };
        path = channelPath(context);
    } else if (/^discord:\/\//i.test(value)) {
        path = stripProtocol(value);
    } else if (/^(https?:\/\/)?([\w-]+\.)*(discord|discordapp)\.(com|gg)\//i.test(value)) {
        path = stripInviteHost(value) ?? stripHost(value);
    } else if (value.startsWith("/")) {
        path = value;
    } else if (SNOWFLAKE.test(value)) {
        switch (kind) {
            case "user":
                path = `/users/${value}`;
                break;
            case "guild":
                path = `/channels/${value}`;
                break;
            case "message":
                if (!context?.channelId) return { ok: false, error: "A message link needs its channel: run this in that channel." };
                path = channelPath({ ...context, messageId: value });
                break;
            default:
                path = `/channels/${context?.guildId || "@me"}/${value}`;
                break;
        }
    }

    if (path === null) return { ok: false, error: "That doesn't look like a Discord link or ID." };

    const normalized = normalizePath(path);
    if (!normalized || normalized === "/") return { ok: false, error: "That link doesn't point at anything the client can open." };

    return { ok: true, link: PROTOCOL + normalized.slice(1), path: normalized };
}

export function userLink(userId: string) {
    return `${PROTOCOL}users/${userId}`;
}

export function channelLink(context: ChannelContext) {
    return `${PROTOCOL}${channelPath(context).slice(1)}`;
}

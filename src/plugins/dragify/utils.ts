/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, Guild, User } from "@limeyV1/discord-types";

const userMentionRegex = /<@!?(\d{17,20})>/;
const userProfileUrlRegex = /discord(?:(?:app)?\.com|:\/\/-?)\/users\/(\d{17,20})/;
const userAvatarRegex = /cdn\.discordapp\.com\/(?:avatars|users)\/(\d{17,20})\//;
const guildUserAvatarRegex = /cdn\.discordapp\.com\/guilds\/\d{17,20}\/users\/(\d{17,20})\/avatars\//;
const channelMentionRegex = /<#(\d{17,20})>/;
const channelUrlRegex = /discord(?:(?:app)?\.com|:\/\/-?)\/channels\/(?:(@me)|(\d{17,20}))\/(\d{17,20})/;
const channelPathRegex = /\/channels\/(@me|\d{17,20})\/(\d{17,20})/;
const messageUrlRegex = /discord(?:(?:app)?\.com|:\/\/-?)\/channels\/(?:(@me)|(\d{17,20}))\/(\d{17,20})\/(\d{17,20})/;
const guildIconRegex = /cdn\.discordapp\.com\/icons\/(\d{17,20})\//;
const limeyPluginUrlRegex = /(?:limey-discord\.onrender\.com|localhost(?::\d+)?)\/plugins?(?:\/|#)([A-Za-z][\w-]*)/;

export type DropEntity =
    | { kind: "user"; id: string; }
    | { kind: "channel"; id: string; guildId?: string; }
    | { kind: "message"; id: string; channelId: string; guildId?: string; }
    | { kind: "guild"; id: string; }
    | { kind: "plugin"; id: string; url: string; };

/** Rich metadata the app attaches so the Limey site can show a readable
 *  pinned chip without asking Discord for anything. */
export interface DragEntityDisplay {
    name: string;
    subtitle?: string;
    iconUrl?: string;
    iconText?: string;
}

export interface DragifyPayload {
    v?: number;
    id?: string;
    userId?: string;
    channelId?: string;
    guildId?: string;
    type?: string;
    kind?: string;
    itemType?: string;
    name?: string;
    subtitle?: string;
    iconUrl?: string;
    iconText?: string;
    url?: string;
    origin?: string;
}

export const DRAGIFY_SITE_ORIGIN = "limey-site";

/** Extra fields padded onto the serialized payload for cross-platform handoff. */
export type SerializedDragPayload = DragifyEntityCore & {
    v: 1 | 2;
    name?: string;
    subtitle?: string;
    iconUrl?: string;
    iconText?: string;
    origin?: string;
};

type DragifyEntityCore =
    | { kind: "user"; id: string; }
    | { kind: "channel"; id: string; guildId?: string; }
    | { kind: "message"; id: string; channelId: string; guildId?: string; }
    | { kind: "guild"; id: string; }
    | { kind: "plugin"; id: string; url: string; };

/** Canonical public URL for external consumers (the site, other apps). */
export function buildEntityUrl(entity: DropEntity): string | null {
    switch (entity.kind) {
        case "channel": {
            const guild = entity.guildId ?? "@me";
            return `https://discord.com/channels/${guild}/${entity.id}`;
        }
        case "message":
            return `https://discord.com/channels/${entity.guildId ?? "@me"}/${entity.channelId}/${entity.id}`;
        case "user":
            return `https://discord.com/users/${entity.id}`;
        case "plugin":
            return entity.url;
        case "guild":
            // guilds have no canonical public URL; keep the payload JSON-only
            return null;
    }
}

type StoreSet = {
    ChannelStore: { getChannel(id: string): Channel | null | undefined; };
    GuildStore: { getGuild(id: string): Guild | null | undefined; };
    UserStore: { getUser(id: string): User | null | undefined; };
};

export function tryParseJson<T = Record<string, unknown>>(value: string): T | null {
    if (!value || value.length < 2 || (value[0] !== "{" && value[0] !== "[")) return null;
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === "object" && parsed ? parsed as T : null;
    } catch {
        return null;
    }
}

export function extractSnowflakeFromString(value: string): string | null {
    const match = value.match(/\d{17,20}/);
    return match?.[0] ?? null;
}

export function extractSnowflakes(values: string[]): string[] {
    const ids = new Set<string>();
    const regex = /\d{17,20}/g;
    for (const value of values) {
        const matches = value.match(regex);
        if (matches) matches.forEach(id => ids.add(id));
    }
    return Array.from(ids);
}

export function extractStrings(dataTransfer: DataTransfer): string[] {
    const collected = new Set<string>();
    const add = (v?: string) => v && collected.add(v);
    add(dataTransfer.getData("text/plain"));
    add(dataTransfer.getData("text/uri-list"));
    add(dataTransfer.getData("text/html"));
    add(dataTransfer.getData("text/x-moz-url"));
    add(dataTransfer.getData("application/json"));
    for (const type of dataTransfer.types ?? []) add(dataTransfer.getData(type));

    const split: string[] = [];
    for (const v of collected) {
        split.push(v);
        if (v.includes("\n")) split.push(...v.split(/\s+/).filter(Boolean));
    }
    return Array.from(new Set(split));
}

export async function collectPayloadStrings(dataTransfer: DataTransfer): Promise<string[]> {
    const sync = extractStrings(dataTransfer);
    const asyncValues: string[] = [];
    const itemPromises = Array.from(dataTransfer.items ?? [])
        .filter(item => item.kind === "string")
        .map(item => new Promise<void>(resolve => item.getAsString(val => {
            if (val) asyncValues.push(val);
            resolve();
        })));
    await Promise.all(itemPromises);
    return Array.from(new Set([...sync, ...asyncValues]));
}

export function serializeDragEntity(entity: DropEntity, display?: DragEntityDisplay, origin?: string) {
    if (!display && !origin) return JSON.stringify(entity);
    return JSON.stringify({
        v: 2,
        kind: entity.kind,
        id: entity.id,
        guildId: (entity as { guildId?: string; }).guildId,
        channelId: (entity as { channelId?: string; }).channelId,
        url: (entity as { url?: string; }).url,
        name: display?.name,
        subtitle: display?.subtitle,
        iconUrl: display?.iconUrl,
        iconText: display?.iconText,
        origin,
    });
}

export function parseDragifyPayload(value: string): DropEntity | null {
    const parsed = tryParseJson<DragifyPayload>(value);
    if (!parsed?.kind || !parsed.id) return null;

    switch (parsed.kind) {
        case "user":
            return { kind: "user", id: parsed.id };
        case "channel":
            return { kind: "channel", id: parsed.id, guildId: parsed.guildId };
        case "message":
            return parsed.channelId
                ? { kind: "message", id: parsed.id, channelId: parsed.channelId, guildId: parsed.guildId }
                : null;
        case "guild":
            return { kind: "guild", id: parsed.id };
        case "plugin":
            return { kind: "plugin", id: parsed.id, url: parsed.url ?? parsed.id };
        default:
            return null;
    }
}

/** Display metadata attached to a v2 payload, if present. */
export function parseDragifyDisplay(value: string): DragEntityDisplay | null {
    const parsed = tryParseJson<DragifyPayload>(value);
    if (!parsed?.name) return null;
    return {
        name: parsed.name,
        subtitle: parsed.subtitle,
        iconUrl: parsed.iconUrl,
        iconText: parsed.iconText,
    };
}

export function parseDragifyOrigin(value: string): string | null {
    const parsed = tryParseJson<DragifyPayload>(value);
    return parsed?.origin ?? null;
}

function parseJsonPayload(payload: DragifyPayload): DropEntity | null {
    const id = payload.id ?? payload.userId ?? payload.channelId ?? payload.guildId;
    if (!id) return null;

    const type = (payload.type ?? payload.kind ?? payload.itemType ?? "").toLowerCase();
    if (type.includes("user")) return { kind: "user", id };
    if (type.includes("message")) return payload.channelId ? { kind: "message", id, channelId: payload.channelId, guildId: payload.guildId } : null;
    if (type.includes("channel")) return { kind: "channel", id, guildId: payload.guildId };
    if (type.includes("plugin")) return { kind: "plugin", id, url: payload.url ?? id };
    if (type.includes("guild") || type.includes("server")) return { kind: "guild", id };
    return null;
}

function parseUserString(value: string): DropEntity | null {
    const userFromMention = userMentionRegex.exec(value);
    if (userFromMention) return { kind: "user", id: userFromMention[1] };

    const userFromProfile = userProfileUrlRegex.exec(value);
    if (userFromProfile) return { kind: "user", id: userFromProfile[1] };

    const guildUserAvatar = guildUserAvatarRegex.exec(value);
    if (guildUserAvatar) return { kind: "user", id: guildUserAvatar[1] };

    const userFromAvatar = userAvatarRegex.exec(value);
    return userFromAvatar ? { kind: "user", id: userFromAvatar[1] } : null;
}

function parseMessageString(value: string): DropEntity | null {
    const messageFromUrl = messageUrlRegex.exec(value);
    if (!messageFromUrl) return null;

    const guildId = messageFromUrl[1] === "@me" ? "@me" : messageFromUrl[2];
    return { kind: "message", id: messageFromUrl[5], channelId: messageFromUrl[4], guildId: guildId ?? undefined };
}

function parsePluginString(value: string): DropEntity | null {
    const pluginFromUrl = limeyPluginUrlRegex.exec(value);
    if (!pluginFromUrl) return null;

    const pluginName = pluginFromUrl[1];
    const base = /localhost/.test(value) ? "http://localhost/plugins" : "https://limey-discord.onrender.com/plugins";
    return { kind: "plugin", id: pluginName, url: `${base}#${pluginName}` };
}

function parseChannelString(value: string): DropEntity | null {
    const channelFromMention = channelMentionRegex.exec(value);
    if (channelFromMention) return { kind: "channel", id: channelFromMention[1] };

    const channelFromUrl = channelUrlRegex.exec(value);
    if (!channelFromUrl) return null;

    const guildId = channelFromUrl[1] === "@me" ? "@me" : channelFromUrl[2];
    return { kind: "channel", id: channelFromUrl[3], guildId: guildId ?? undefined };
}

function parseGuildString(value: string): DropEntity | null {
    const guildFromIcon = guildIconRegex.exec(value);
    return guildFromIcon ? { kind: "guild", id: guildFromIcon[1] } : null;
}

export function parseFromStrings(payloads: string[], stores: StoreSet): DropEntity | null {
    if (payloads.length === 0) return null;

    const values = payloads
        .map(value => value.trim())
        .filter(Boolean);

    for (const value of values) {
        const parsed = tryParseJson<DragifyPayload>(value);
        if (!parsed) continue;

        const jsonEntity = parseJsonPayload(parsed);
        if (jsonEntity) return jsonEntity;
    }

    for (const value of values) {
        const messageEntity = parseMessageString(value);
        if (messageEntity) return messageEntity;
    }

    for (const value of values) {
        const userEntity = parseUserString(value);
        if (userEntity) return userEntity;
    }

    for (const value of values) {
        const channelEntity = parseChannelString(value);
        if (channelEntity) return channelEntity;
    }

    for (const value of values) {
        const pluginEntity = parsePluginString(value);
        if (pluginEntity) return pluginEntity;
    }

    for (const value of values) {
        const guildEntity = parseGuildString(value);
        if (guildEntity) return guildEntity;
    }

    const candidates = extractSnowflakes(values);
    for (const candidate of candidates) {
        if (stores.ChannelStore.getChannel(candidate)) return { kind: "channel", id: candidate };
        if (stores.GuildStore.getGuild(candidate)) return { kind: "guild", id: candidate };
        if (stores.UserStore.getUser(candidate)) return { kind: "user", id: candidate };
    }
    return null;
}

export function extractChannelPath(value: string): { guildId?: string; channelId?: string; } | null {
    const channelPath = channelPathRegex.exec(value);
    if (!channelPath) return null;
    return {
        guildId: channelPath[1] === "@me" ? "@me" : channelPath[1],
        channelId: channelPath[2]
    };
}

export function extractChannelFromUrl(value: string): { guildId?: string; channelId?: string; } | null {
    const channelFromUrl = channelUrlRegex.exec(value);
    if (!channelFromUrl) return null;
    const guildId = channelFromUrl[1] ?? channelFromUrl[2];
    return {
        guildId: guildId === "@me" ? "@me" : guildId,
        channelId: channelFromUrl[3]
    };
}

export function extractUserFromAvatar(value: string): string | null {
    const guildUserAvatar = guildUserAvatarRegex.exec(value);
    if (guildUserAvatar?.[1]) return guildUserAvatar[1];
    const userAvatar = userAvatarRegex.exec(value);
    if (userAvatar?.[1]) return userAvatar[1];
    return null;
}

export function extractUserFromProfile(value: string): string | null {
    const match = userProfileUrlRegex.exec(value);
    return match?.[1] ?? null;
}

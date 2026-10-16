/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType } from "@limeyV1/discord-types/enums";
import { getGuildAcronym } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { ChannelStore, GuildStore, IconUtils, RelationshipStore, showToast, UserStore } from "@webpack/common";

import {
    type DragEntityDisplay,
    DRAGIFY_SITE_ORIGIN,
    type DragifyPayload,
    type DropEntity,
    parseDragifyPayload,
    serializeDragEntity,
} from "./utils";

const logger = new Logger("Dragify");

/**
 * Cross-platform handoff ("Dragify across platforms") between this Discord
 * tab and Limey V1 web pages ("the site"). Messages hop:
 *
 *   app (MAIN world)  <->  content.js (ISOLATED)  <->  extension background  <->  site content.js  <->  site page
 *
 * Outgoing app->site events are posted as { type: "limeyV1:dragify" } with an
 * action of "send" (pin to the site) or an ack ("opened" / "delivered");
 * everything coming back from the site arrives as
 * { type: "limeyV1:dragify:incoming" } and delivery acks as
 * { type: "limeyV1:dragify:ack" }. The distinct type names keep the two loops
 * from talking to themselves.
 */

export type SiteRelayAction = "send" | "opened" | "delivered";

function describeForWire(entity: DropEntity): DragEntityDisplay | null {
    return describeEntity(entity);
}

/** The extension content script confirms itself via the existing meta handshake. */
let extensionDetected = false;
let controller: AbortController | null = null;
/** Callbacks awaiting a delivery ack for an outgoing action. */
const pendingAcks = new Map<string, (contacted: number) => void>();
let ackSeq = 0;

export function isSiteAvailable() {
    return extensionDetected;
}

export function markExtensionDetected(version: string | undefined) {
    if (!extensionDetected) {
        extensionDetected = true;
        logger.debug("Limey extension detected", version ?? "(unknown version)");
    }
}

function describeChannel(channel: NonNullable<ReturnType<typeof ChannelStore.getChannel>>): { name: string; subtitle: string; iconUrl?: string; iconText?: string; } {
    const isThread = channel.isThread();
    const isGroupDm = channel.type === ChannelType.GROUP_DM;
    const displayName = isGroupDm
        ? getGroupDmDisplayName(channel)
        : channel.name;
    const name = `${isThread || isGroupDm ? "🧵" : "#"}${displayName || "channel"}`;
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    const subtitle = guild?.name ?? "Direct Messages";

    let iconUrl: string | undefined;
    if (guild?.icon) iconUrl = IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64 }) ?? undefined;
    else if (isGroupDm) {
        const channelIcon = IconUtils.getChannelIconURL?.({
            id: channel.id,
            icon: (channel as unknown as { icon?: string | null; }).icon ?? undefined,
            size: 64,
        });
        iconUrl = channelIcon ?? undefined;
    } else if (channel.isDM()) {
        const recipientId = channel.getRecipientId() ?? channel.recipients?.[0];
        const recipient = recipientId ? UserStore.getUser(recipientId) : null;
        iconUrl = recipient?.getAvatarURL(undefined, 80, true);
    }

    return { name, subtitle, iconUrl, iconText: undefined };
}

function getGroupDmDisplayName(channel: NonNullable<ReturnType<typeof ChannelStore.getChannel>>): string | null {
    if (channel.type !== ChannelType.GROUP_DM) return null;
    const selfId = UserStore.getCurrentUser()?.id ?? null;
    const recipients = (channel.recipients ?? []).filter(Boolean);
    const names = recipients
        .filter(id => id !== selfId)
        .map(id => {
            const user = UserStore.getUser(id);
            return RelationshipStore?.getNickname?.(id) ?? user?.globalName ?? user?.username ?? null;
        })
        .filter(Boolean);
    return names.length > 1 ? names.join(", ") : names[0] ?? null;
}

/** Build the rich chip data the site shows when a drop arrives. */
export function describeEntity(entity: DropEntity): DragEntityDisplay | null {
    switch (entity.kind) {
        case "user": {
            const user = UserStore.getUser(entity.id);
            if (!user) return { name: "User", subtitle: "Discord user" };
            return {
                name: user.globalName ?? user.username,
                subtitle: user.username ? `@${user.username}` : "Discord user",
                iconUrl: user.getAvatarURL(undefined, 80, true) ?? undefined,
                iconText: "@",
            };
        }
        case "channel": {
            const channel = ChannelStore.getChannel(entity.id);
            return channel
                ? describeChannel(channel)
                : { name: `#${entity.id}`, subtitle: "Discord channel" };
        }
        case "message": {
            const channel = ChannelStore.getChannel(entity.channelId);
            if (!channel) return { name: "Message", subtitle: "Discord message" };
            const isGroupDm = channel.type === ChannelType.GROUP_DM;
            const channelName = isGroupDm ? getGroupDmDisplayName(channel) ?? "DM" : `#${channel.name}`;
            return {
                name: `Message in ${channelName}`,
                subtitle: "Discord message · click to open in the app",
                iconText: "💬",
            };
        }
        case "guild": {
            const guild = GuildStore.getGuild(entity.id);
            return {
                name: guild?.name ?? "Server",
                subtitle: "Discord server",
                iconUrl: guild?.icon ? IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 64 }) ?? undefined : undefined,
                iconText: guild ? getGuildAcronym(guild) : "S",
            };
        }
        case "plugin": {
            return {
                name: entity.id,
                subtitle: "Limey V1 plugin",
                iconText: "🍋",
            };
        }
    }
}

function postToSite(action: SiteRelayAction, payload: Record<string, unknown>) {
    try {
        window.postMessage({
            type: "limeyV1:dragify",
            action,
            ...payload,
        }, "*");
    } catch (err) {
        logger.error("Failed posting to the site relay bridge", err);
    }
}

/** Push an entity chip to every open Limey site tab (via the extension). */
export function sendToSite(entity: DropEntity): void {
    const display = describeForWire(entity) ?? undefined;
    const serialized = serializeDragEntity(entity, display, DRAGIFY_SITE_ORIGIN);
    let wire: DragifyPayload;
    try {
        wire = JSON.parse(serialized) as DragifyPayload;
    } catch {
        return;
    }

    const seq = String(++ackSeq);
    pendingAcks.set(seq, contacted => {
        if (contacted > 0) {
            showToast("Sent to the Limey V1 site.", "success");
        } else {
            showToast("No Limey site tab found — open it first.", "failure");
        }
        pendingAcks.delete(seq);
    });

    postToSite("send", { entity: wire, seq });
    // Safety net: if no ack ever returns, drop the pending entry; the toast is
    // simply skipped instead of lying about delivery.
    setTimeout(() => pendingAcks.delete(seq), 5000);
}

function resolveInbound(entityIn: DragifyPayload | null): DropEntity | null {
    if (!entityIn) return null;
    return parseDragifyPayload(JSON.stringify(entityIn));
}

function handleMessage(event: MessageEvent) {
    if (event.source !== window) return;
    const data = event.data as { type?: string; action?: string; entity?: DragifyPayload; seq?: string; contacted?: number; version?: string; }
        | null
        | undefined;
    if (!data || typeof data !== "object") return;

    // The extension's handshake tells us the site relay can be shown.
    if (data.type === "limeyV1:meta") {
        markExtensionDetected((data as unknown as { meta?: { EXTENSION_VERSION?: string; }; }).meta?.EXTENSION_VERSION);
        return;
    }

    switch (data.type) {
        // Site -> app: the pinned chip's "Open in app" action.
        case "limeyV1:dragify:incoming": {
            if (data.action !== "open") return;
            const entity = resolveInbound(data.entity ?? null);
            if (!entity) return;
            openHandler?.(entity);
            return;
        }
        // ISOLATED world echo of the background's "contacted" count for sends.
        case "limeyV1:dragify:ack": {
            if (data.action === "send") {
                pendingAcks.get(String(data.seq ?? ""))?.(Number(data.contacted ?? 0));
            }
            return;
        }
    }
}

let openHandler: ((entity: DropEntity) => void) | null = null;

export function setOpenHandler(handler: ((entity: DropEntity) => void) | null) {
    openHandler = handler;
}

/** Flash an existing chip on the site ("opened in app ✓" / "inserted ✓"). */
export function ackToSite(action: "opened" | "delivered", entity: DropEntity, extra: Record<string, unknown> = {}) {
    const display = describeForWire(entity) ?? undefined;
    const serialized = serializeDragEntity(entity, display, DRAGIFY_SITE_ORIGIN);
    try {
        const wire = JSON.parse(serialized) as DragifyPayload;
        postToSite(action, { entity: wire, ...extra });
    } catch (err) {
        logger.error("Failed building the site ack", err);
    }
}

export function listen() {
    controller = new AbortController();
    window.addEventListener("message", handleMessage, { signal: controller.signal });
}

export function unlisten() {
    controller?.abort();
    controller = null;
    pendingAcks.clear();
}

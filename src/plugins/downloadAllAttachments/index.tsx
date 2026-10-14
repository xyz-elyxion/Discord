/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { CloudDownloadIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Message, MessageAttachment } from "@limeyV1/discord-types";
import { ChannelStore, showToast } from "@webpack/common";

// Limey V1 port note: replaces @utils/misc's pluralize helper (present in
// Equicord, absent here) with the same semantics.
function pluralize(amount: number, singular: string, plural = singular + "s") {
    return amount === 1 ? `${amount} ${singular}` : `${amount} ${plural}`;
}

const logger = new Logger("DownloadAllAttachments");

const settings = definePluginSettings({
    downloadAllFileTypes: {
        type: OptionType.BOOLEAN,
        description: "Also download non-media attachments. Only enable this if you trust what people send you.",
        default: false
    }
});

async function downloadAll(attachments: MessageAttachment[]) {
    const usedNames = new Map<string, number>();

    function uniqueName(original: string): string {
        const count = usedNames.get(original) ?? 0;
        usedNames.set(original, count + 1);
        if (count === 0) return original;
        const dot = original.lastIndexOf(".");
        return dot === -1
            ? `${original}_${count}`
            : `${original.slice(0, dot)}_${count}${original.slice(dot)}`;
    }

    const results = await Promise.allSettled(attachments.map(async attachment => {
        const filename = uniqueName(attachment.filename);
        const sources = [attachment.proxy_url];
        if (settings.store.downloadAllFileTypes) sources.push(attachment.url);
        if (!sources.some(Boolean)) throw new Error("Missing attachment URL");

        let res: Response | undefined;
        for (const source of sources) {
            if (!source) continue;
            res = await fetch(source).catch(() => undefined);
            if (res?.ok) break;
        }
        if (!res?.ok) throw new Error(res ? `HTTP ${res.status}` : "Network error");

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }));

    const failed = results.filter(r => {
        if (r.status === "rejected") {
            logger.warn("Failed to download attachment:", r.reason);
            return true;
        }
        return false;
    }).length;

    const succeeded = attachments.length - failed;

    if (failed === 0)
        showToast(`Downloaded ${pluralize(succeeded, "attachment")}.`, "success");
    else
        showToast(`Downloaded ${succeeded} of ${attachments.length} attachments. ${failed} failed.`, "failure");
}

export default definePlugin({
    name: "DownloadAllAttachments",
    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own events and stores to read the content, authors and attachments of messages you can already see.",
            risk: "A buggy or abused plugin could collect, copy or act on private conversations."
        },
        {
            id: "fileAccess",
            title: "Download files",
            description: "Downloads all attachments of a message to your device through your browser/app downloads.",
            risk: "Downloads can pull large or malicious files onto your disk; check filenames before opening."
        }
    ],
    description: "Adds a popover button to download all attachments in a message at once.",
    tags: ["Utility", "Chat"],
    authors: [Devs.dhopcs],
    dependencies: ["MessagePopoverAPI"],
    settings,
    messagePopoverButton: {
        icon: CloudDownloadIcon,
        render(message: Message) {
            if (!message.attachments.length) return null;
            return {
                label: "Download All Attachments",
                icon: CloudDownloadIcon,
                message,
                channel: ChannelStore.getChannel(message.channel_id),
                onClick: () => downloadAll(message.attachments)
            };
        }
    }
});

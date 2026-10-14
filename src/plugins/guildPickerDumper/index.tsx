/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Guild } from "@limeyV1/discord-types";
import { EmojiStore, Menu, StickersStore } from "@webpack/common";
import { zipSync } from "fflate";

const StickerExt = [, "png", "apng", "json", "gif"] as const;

const Patch: NavContextMenuPatchCallback = (children, { guild }: { guild: Guild; }) => {
    const group = findGroupChildrenByChildId("privacy", children);

    if (group) {
        group.push(
            <>
                <Menu.MenuItem id="emoji.download" label="Download Emojis" action={() => zipGuildAssets(guild, "emojis")}></Menu.MenuItem>
                <Menu.MenuItem id="sticker.download" label="Download Stickers" action={() => zipGuildAssets(guild, "stickers")}></Menu.MenuItem>
            </>
        );
    }
};

async function zipGuildAssets(guild: Guild, type: "emojis" | "stickers") {
    const isEmojis = type === "emojis";
    const items = isEmojis
        ? EmojiStore.getGuilds()[guild.id]?.emojis
        : StickersStore.getStickersByGuildId(guild.id);

    if (!items) {
        return console.log("Server not found!");
    }

    const getProxyEndpoint = () => {
        const rawEndpoint = window.GLOBAL_ENV.MEDIA_PROXY_ENDPOINT;
        return rawEndpoint.startsWith("//") ? rawEndpoint.slice(2) : rawEndpoint;
    };

    const fetchAsset = async (e: any) => {
        let ext: string;
        let url: string;
        const endpoint = getProxyEndpoint();

        if (isEmojis) {
            ext = e.animated ? ".gif" : ".png";
            url = `https://${endpoint}/emojis/${e.id}${ext}?size=512&quality=lossless`;
        } else {
            ext = "." + StickerExt[e.format_type];
            const urlExt = e.format_type === 2 ? ".png" : ext;
            url = `https://${endpoint}/stickers/${e.id}${urlExt}?size=4096&lossless=true`;
        }

        const sanitizedName = e.name.replace(/[<>:"/\\|?*]/g, "_");
        let filename = `${sanitizedName}_${e.id}${ext}`;

        let response = await fetch(url);

        if (!isEmojis && e.format_type === 2 && (!response.ok || response.headers.get("content-type")?.includes("text"))) {
            const gifUrl = `https://${endpoint}/stickers/${e.id}.gif?size=4096&lossless=true`;
            const gifResponse = await fetch(gifUrl);

            if (gifResponse.ok && !gifResponse.headers.get("content-type")?.includes("text")) {
                response = gifResponse;
                ext = ".gif";
                filename = `${sanitizedName}_${e.id}${ext}`;
            }
        }

        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        return { file: new Uint8Array(arrayBuffer), filename };
    };

    const assetPromises = items.map(e => fetchAsset(e));

    Promise.all(assetPromises)
        .then(results => {
            const zipped = zipSync(Object.fromEntries(results.map(({ file, filename }) => [filename, file])));
            const blob = new Blob([new Uint8Array(zipped)], { type: "application/zip" });
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = `${guild.name}-${type}.zip`;
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        })
        .catch(console.error);
}

export default definePlugin({
    name: "GuildPickerDumper",
    permissions: [
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Downloads a server's emoji, sticker and icon assets from Discord's CDNs.",
            risk: "Requests are made with your session; destinations see your IP address."
        },
        {
            id: "fileAccess",
            title: "Download files",
            description: "Saves the downloaded assets (emojis/stickers) to a local folder you choose.",
            risk: "Downloads could write large numbers of files to disk; check the target folder."
        }
    ],
    description: "Context menu to dump and download a server's emojis and stickers.",
    tags: ["Emotes", "Servers", "Utility"],
    authors: [Devs.Cortex, Devs.Samwich, Devs.Synth, Devs.thororen],
    contextMenus: {
        "guild-context": Patch,
        "guild-header-popout": Patch
    }
});

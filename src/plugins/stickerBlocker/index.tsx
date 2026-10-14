/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import React, { ReactNode } from "react";
import { findCssClassesLazy } from "@webpack";
import { Menu } from "@webpack/common";
import { Button } from "@components/Button";

const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const MessageContentClasses = findCssClassesLazy("messageContent", "messageContentTrailingIcon");

const settings = definePluginSettings({
    showGif: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a snazzy cat gif",
        default: true,
        restartNeeded: true
    },
    showMessage: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a message detailing which id was blocked",
        default: false,
        restartNeeded: true
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Whether to show a button to unblock the gif",
        default: true,
        restartNeeded: true
    },
    blockedStickers: {
        type: OptionType.STRING,
        description: "The list of blocked sticker IDs (don't edit unless you know what you're doing)",
        default: ""
    }
});

function blockedComponentRender(sticker) {
    const { showGif, showMessage, showButton } = settings.store;
    const elements = [] as ReactNode[];

    if (showGif) {
        elements.push(
            <img key="gif" src="https://equicord.org/assets/plugins/stickerBlocker/blocked.gif" style={{ width: "160px", borderRadius: "20px" }} />
        );
    }

    if (showMessage) {
        elements.push(
            <div key="message" id="vc-blocked-sticker" className={classes(CodeContainerClasses.markup, MessageContentClasses.messageContent)}><span>Blocked Sticker. ID: {sticker.id}, NAME: {sticker.name}</span></div>
        );
    }

    if (showButton) {
        elements.push(
            <Button key="button" variant="dangerSecondary" onClick={() => toggleBlock(sticker.id)}>Unblock {(showMessage) ? "" : sticker.name}</Button>
        );
    }

    return <>{elements}</>;
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const { favoriteableId, favoriteableType } = props ?? {};

    if (!favoriteableId) return;

    const menuItem = (() => {
        switch (favoriteableType) {
            case "sticker":
                const sticker = props.message.stickerItems.find(s => s.id === favoriteableId);
                if (sticker?.format_type === 3 /* LOTTIE */) return;

                return buildMenuItem(favoriteableId);
        }
    })();

    if (menuItem)
        findGroupChildrenByChildId("copy-link", children)?.push(menuItem);
};

const expressionPickerPatch: NavContextMenuPatchCallback = (children, props: { target: HTMLElement; }) => {
    const { id, type } = props?.target?.dataset ?? {};
    if (!id) return;

    if (type === "sticker" && !props.target.className?.includes("lottieCanvas")) {
        children.push(buildMenuItem(id));
    }
};

function buildMenuItem(name) {
    return (
        <Menu.MenuItem
            id="limey-add-sticker-block"
            key="limey-add-sticker-block"
            label={(isStickerBlocked(name)) ? "Unblock Sticker" : "Block Sticker"}
            action={() => toggleBlock(name)}
        />
    );
}

function toggleBlock(name) {
    if (settings.store.blockedStickers === undefined || settings.store.blockedStickers == null) {
        return;
    }
    const excepted = isStickerBlocked(name);
    if (excepted) {
        settings.store.blockedStickers = settings.store.blockedStickers.split(", ").filter(item => item !== name).join(", ");
    } else {
        settings.store.blockedStickers = settings.store.blockedStickers.split(", ").concat(name).join(", ");
    }
}

function isStickerBlocked(name) {
    if (settings.store.blockedStickers === undefined || settings.store.blockedStickers == null) {
        return;
    }
    return settings.store.blockedStickers.split(", ").includes(name);
}

export default definePlugin({
    name: "StickerBlocker",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Keeps plugin data (settings, caches, history) in the client's local DataStore.",
            risk: "Data persists on your device between sessions; deleted content may be retained here."
        },
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Loads a small placeholder image from the plugin's CDN for blocked stickers.",
            risk: "Requests are made with your session; destinations see your IP address."
        }
    ],
    description: "Allows you to block stickers from being displayed.",
    tags: ["Chat", "Emotes", "Utility"],
    authors: [Devs.Samwich],
    patches: [
        {
            find: ".STICKERS_CONSTANTS_STICKER_DIMENSION)",
            replacement: {
                match: /\}\),\(\i\?\?(\i)\)\.name\]\}\);/,
                replace: "$& if($self.isBlocked($1.id)) return($self.blockedComponent($1));"
            }
        }
    ],
    contextMenus: {
        "message": messageContextMenuPatch,
        "expression-picker": expressionPickerPatch,
    },
    start() {
        DataStore.createStore("StickerBlocker", "data");
    },

    isBlocked(stickerId) {
        if (settings.store.blockedStickers.split(", ").includes(stickerId)) {
            return true;
        }

        return false;
    },
    blockedComponent: ErrorBoundary.wrap(blockedComponentRender, { fallback: () => <p style={{ color: "red" }}>Failed to render :(</p> }),
    settings,
});

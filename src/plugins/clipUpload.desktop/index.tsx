/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { CloudUploadIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu } from "@webpack/common";

import { abortActiveClipUploads, type ClipMetadata } from "./upload";
import { openUploadClipFileModal } from "./UploadClipFileModal";

const ActionBarIcon = findComponentByCodeLazy("Children.map", "isValidElement", "dangerous:");

interface ClipUploadActionProps {
    channelId: string;
    clip?: ClipMetadata | null;
}

const ctxMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props.channel) return;

    children.push(
        <Menu.MenuItem
            id="vc-upload-clip-file"
            iconLeft={CloudUploadIcon}
            label="Upload Clip File"
            action={() => openUploadClipFileModal(props.channel.id)}
        />
    );
};

export default definePlugin({
    name: "ClipUpload",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Downloads the clip's encoder assets from public CDNs (jsDelivr).",
            risk: "Requests are made with your session; destinations see your IP address."
        },
        {
            id: "fileAccess",
            title: "Read and package files",
            description: "Reads the local video file you pick and converts it into a Discord clip upload.",
            risk: "Local files are processed on your device — never send files you don't own."
        }
    ],
    description: "Adds a button to upload a local video file as a Discord clip.",
    authors: [Devs.qdnx, Devs.BachLe2000, Devs.pandaptable, Devs.Nyro, Devs.Jahsohsani],
    tags: ["Media", "Utility"],

    patches: [
        {
            find: '"ChannelAttachmentUpload"',
            replacement: {
                match: /(?<=description:\i,spoiler:\i.{0,160},\{children:\[)/,
                replace: "$&$self.UploadClipFileButton(arguments[0]),"
            }
        }
    ],

    contextMenus: {
        "channel-attach": ctxMenuPatch
    },

    stop: abortActiveClipUploads,

    UploadClipFileButton: ErrorBoundary.wrap(({ channelId, clip }: ClipUploadActionProps) => {
        if (!clip) return null;

        return (
            <ActionBarIcon
                tooltip="Upload clip file"
                onClick={() => openUploadClipFileModal(channelId, clip)}
            >
                <CloudUploadIcon width={20} height={20} />
            </ActionBarIcon>
        );
    }, { noop: true })
});

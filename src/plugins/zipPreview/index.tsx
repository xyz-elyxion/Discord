/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin from "@utils/types";

import { cl, SafeZipPreviewInline } from "./components";
import managedStyle from "./style.css?managed";
import { clearZipPreviewCache, getAttachmentFileName, isZipFile, ZipPreviewAttachmentProps } from "./utils";

export default definePlugin({
    name: "ZipPreview",
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
            description: "Fetches ZIP attachment contents from Discord's CDNs to render the preview.",
            risk: "Requests are made with your session; destinations see your IP address."
        }
    ],
    description: "Previews ZIP contents inside file attachments.",
    tags: ["Chat", "Utility"],
    authors: [Devs.justjxke],
    managedStyle,

    patches: [
        {
            find: "#{intl::IMG_ALT_ATTACHMENT_FILE_TYPE}",
            replacement: {
                match: /(?<=renderAdjacentContent:\i}=(\i);.{0,120}className:)(\i\.\i)(,children:\[)/,
                replace: "$self.fileClassName($2)$3$self.renderZipPreview($1),"
            }
        }
    ],

    stop() {
        clearZipPreviewCache();
    },

    renderZipPreview(props: ZipPreviewAttachmentProps) {
        if (!isZipFile(getAttachmentFileName(props))) return null;
        return <SafeZipPreviewInline {...props} />;
    },

    fileClassName(className: string) {
        return classes(className, cl("file"));
    }
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isPluginEnabled } from "@api/PluginManager";
import anonymiseFileNames, { tarExtMatcher } from "@plugins/anonymiseFileNames";
import { Devs } from "@utils/constants";
import definePlugin, { ReporterTestable } from "@utils/types";
import { CloudUpload } from "@limeyV1/discord-types";

const extensionMap = {
    "ogg": [".ogv", ".oga", ".ogx", ".ogm", ".spx", ".aac", ".wma"],
    "jpg": [".jpe", ".jif", ".jfi", ".pjpeg", ".pjp", ".bmp", ".tiff", ".tif"],
    "svg": [".svgz", ".ai", ".eps"],
    "mp4": [".m4v", ".m4r", ".m4p", ".avi", ".mkv", ".wmv", ".flv", ".3gp"],
    "m4a": [".m4b", ".aiff"],
    "mov": [".movie", ".qt", ".asf", ".rm", ".rmvb"],
    "png": [".ico", ".cur"],
};

export const reverseExtensionMap = Object.entries(extensionMap).reduce((acc, [target, exts]) => {
    exts.forEach(ext => acc[ext] = `.${target}`);
    return acc;
}, {} as Record<string, string>);

export default definePlugin({
    name: "FixFileExtensions",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    authors: [Devs.thororen],
    description: "Fixes file extensions by renaming them to a compatible supported format if possible",
    tags: ["Media", "Utility"],
    reporterTestable: ReporterTestable.None,
    patches: [
        // Taken from AnonymiseFileNames
        {
            find: "async uploadFiles(",
            replacement: [
                {
                    match: /async uploadFiles\((\i)\){/,
                    replace: "$&$1.forEach($self.fixExt);"
                }
            ],
            predicate: () => !isPluginEnabled(anonymiseFileNames.name),
        },
    ],
    fixExt(upload: CloudUpload) {
        const file = upload.filename;
        const tarMatch = tarExtMatcher.exec(file);
        const extIdx = tarMatch?.index ?? file.lastIndexOf(".");
        const fileName = extIdx !== -1 ? file.substring(0, extIdx) : "";
        const ext = extIdx !== -1 ? file.slice(extIdx) : "";
        const newExt = reverseExtensionMap[ext] || ext;

        upload.filename = fileName + newExt;
    },
});

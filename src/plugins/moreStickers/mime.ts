/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Adapted from the upstream fileUpload plugin's utils/getMediaUrl.ts,
 * vendored here because only getMimeFromExtension is needed by
 * moreStickers and the fileUpload plugin is not ported in this codebase.
 */

const extensionToMime: Record<string, string> = {
    "png": "image/png",
    "apng": "image/apng",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "tiff": "image/tiff",
    "avif": "image/avif",
    "svg": "image/svg+xml",
    "mp4": "video/mp4",
    "webm": "video/webm",
    "ogg": "video/ogg",
    "avi": "video/x-msvideo",
    "wmv": "video/x-ms-wmv",
    "flv": "video/x-flv",
    "mov": "video/quicktime",
    "mkv": "video/x-matroska"
};

export function getMimeFromExtension(ext?: string): string {
    return extensionToMime[ext?.toLowerCase() ?? ""] || "application/octet-stream";
}

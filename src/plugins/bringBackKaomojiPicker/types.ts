/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PropsWithChildren } from "react";

export enum ExpressionPickerView {
    EMOJI = "emoji",
    GIF = "gif",
    STICKER = "sticker",
    SOUNDBOARD = "soundboard",
    KAOMOJI = "kaomoji"
}

export interface ExpressionPickerTabProps extends PropsWithChildren {
    id?: string;
    "aria-controls"?: string;
    "aria-selected"?: boolean;
    isActive?: boolean;
    viewType: ExpressionPickerView;
}

export interface KaomojiItem {
    name: string;
    kaomoji: string;
}

export type KaomojiCategories = Record<string, KaomojiItem[]>;

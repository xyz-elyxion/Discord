/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "@vencord/types";

declare global {
    export var LimeyV1Native: typeof import("preload/LimeyV1Native").LimeyV1Native;
    export var LimeyV1Desktop: typeof import("renderer/index");
    export var LimeyV1PatchGlobals: any;

    // The injected client mod is the Limey fork — its runtime global was
    // renamed from upstream Vencord to LimeyV1 (see the mod's build config).
    export var LimeyV1: typeof import("@vencord/types/Vencord");

    export var IS_DEV: boolean;
}

// The shipped @vencord/types package is the upstream (Vencord) snapshot; the
// Limey fork renames these symbols at runtime, so teach the type package the
// renamed names we consume.
declare module "@vencord/types/components" {
    export function LimeyV1DesktopSettingsIcon(
        props: import("@vencord/types/components/Icons").IconProps
    ): JSX.Element;
}

export {};

/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Menu } from "@limeyV1/discord-types";
import { unwrapLazy } from "@utils/lazy";
import { DefaultExtractAndLoadChunksRegex, extractAndLoadChunksLazy, filters } from "@webpack";
import { ComponentProps, ComponentType } from "react";

import { ThreadChannel } from "../../types";
import { findSingleExportLazy } from "../../utils";

export const requireThreadContextMenu = extractAndLoadChunksLazy(
    ["openThreadContextMenu"],
    new RegExp("openThreadContextMenu.{1,150}?" + DefaultExtractAndLoadChunksRegex.source)
);

interface ThreadContextMenuProps extends ComponentProps<Menu["Menu"]> {
    channel: ThreadChannel;
}

// Discord does not always export this menu as default/Z/ZP, so also look for the component
// exporting the marker it is found by. Both lookups stay lazy: an unresolved lazy is a proxy
// built on a function, and rendering one throws "proxyLazy called on a primitive value".
const ThreadContextMenuLazy = findSingleExportLazy<ComponentType<ThreadContextMenuProps>>(
    ".CHANNEL_LIST_THREAD_MENU]"
);
const ThreadContextMenuByCodeLazy = findSingleExportLazy<ComponentType<ThreadContextMenuProps>>(
    ".CHANNEL_LIST_THREAD_MENU]",
    filters.componentByCode(".CHANNEL_LIST_THREAD_MENU]")
);

/**
 * Resolves Discord's thread context menu without going through the proxy's get trap, which
 * throws once the lazy resolved to nothing. Call this only after {@link requireThreadContextMenu}
 * finished loading the chunk the menu lives in.
 */
export function getThreadContextMenu(): ComponentType<ThreadContextMenuProps> | undefined {
    for (const lazy of [ThreadContextMenuLazy, ThreadContextMenuByCodeLazy]) {
        const component: unknown = unwrapLazy(lazy);

        if (typeof component === "function" || typeof component === "object")
            return component as ComponentType<ThreadContextMenuProps>;
    }

    return undefined;
}

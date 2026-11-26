/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { ContextMenuApi, useMemo } from "@webpack/common";
import { MouseEvent } from "react";

import {
    getThreadContextMenu,
    requireThreadContextMenu,
} from "../../components/ContextMenus/ThreadContextMenu";
import { ForumPostEventOptions } from "../../types";

const logger = new Logger("BetterForums");

export function useForumPostEvents({ channel, goToThread }: ForumPostEventOptions) {
    return useMemo(
        () => ({
            handleLeftClick: (e: MouseEvent) => e.target && goToThread(channel, e.shiftKey),
            handleRightClick: (e: MouseEvent) =>
                ContextMenuApi.openContextMenuLazy(e, () =>
                    requireThreadContextMenu().then(() => menuProps => {
                        // Resolve the menu here, once the chunk holding it has loaded, and render
                        // nothing rather than an unresolved lazy when Discord moved it.
                        const ThreadContextMenu = getThreadContextMenu();
                        if (!ThreadContextMenu) {
                            logger.warn("Could not find Discord's thread context menu");
                            return null;
                        }

                        return <ThreadContextMenu channel={channel} {...menuProps} />;
                    })
                ),
        }),
        [channel, goToThread]
    );
}

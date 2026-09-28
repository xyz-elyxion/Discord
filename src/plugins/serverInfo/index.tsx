/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2023 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { InfoIcon } from "@components/Icons";
import { Guild } from "@limeyV1/discord-types";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { openGuildInfoModal } from "./GuildInfoModal";

const makePatch: (showIcon: boolean) => NavContextMenuPatchCallback = showIcon => (children, { guild }: { guild: Guild; }) => {
    const group = findGroupChildrenByChildId("privacy", children);

    group?.push(
        <Menu.MenuItem
            id="vc-server-info"
            label="Server Info"
            leadingAccessory={showIcon ? { type: "icon", icon: InfoIcon } : undefined}
            action={() => openGuildInfoModal(guild)}
        />
    );
};

export default definePlugin({
    name: "ServerInfo",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Allows you to view info about a server",
    tags: ["Servers", "Utility"],
    authors: [Devs.Ven, Devs.Nuckyz],
    dependencies: ["DynamicImageModalAPI"],
    searchTerms: ["guild", "info", "ServerProfile"],

    contextMenus: {
        "guild-context": makePatch(false),
        "guild-header-popout": makePatch(true)
    }
});

/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { Channel, User } from "@limeyV1/discord-types";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { GuildStore, React, SelectedGuildStore } from "@webpack/common";
import { shouldHideInDiscord } from "@plugins/ghostClient";

export default definePlugin({
    name: "ForceOwnerCrown",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Force the owner crown next to usernames even if the server is large. When the Ghost Client overlay is connected, the forced crown renders on the overlay instead of inside Discord — drawn ESP-style directly at the owner's spot in the member list.",
    authors: [Devs.D3SOX, Devs.Nickyux],
    tags: ["Roles", "Appearance", "Servers"],
    patches: [
        {
            find: "#{intl::GUILD_OWNER}),children:",
            replacement: {
                match: /(?<=decorators:.{0,200}?isOwner:)\i/,
                replace: "$self.isGuildOwner(arguments[0])"
            }
        }
    ],
    isGuildOwner(props: { user: User, channel: Channel, isOwner: boolean, guildId?: string; }) {
        // Ghost Client overlay mode: the forced crown lives on the Ghost Client
        // EXE, not inside the client where Limey V1 is installed. Fall back to
        // Discord's own isOwner so nothing native disappears too.
        if (shouldHideInDiscord()) return props.isOwner;

        if (!props?.user?.id) return props.isOwner;
        if (props.channel?.type === 3 /* GROUP_DM */)
            return props.isOwner;

        // guild id is in props twice, fallback if the first is undefined
        const guildId = props.guildId ?? props.channel?.guild_id;
        const userId = props.user.id;

        return GuildStore.getGuild(guildId)?.ownerId === userId;
    },

    start() {
        // Ghost-only mode: instead of forcing the crown into Discord, drop an
        // invisible "anchor" into the owner's member-list row. The Ghost Client
        // EXE reads these anchors' live screen positions and draws the crown
        // exactly where it belongs — ESP-style, over the Discord window.
        addMemberListDecorator("ForceOwnerCrown", props => {
            if (!shouldHideInDiscord()) return null;
            if (!props?.user?.id) return null;

            // props.isOwner is the patch context's own ownership decision; not
            // every member-list patch context carries it, so fall back to
            // checking the selected guild's owner directly.
            const isOwner = props.isOwner ??
                (() => {
                    // Not every member-list patch context carries isOwner, so
                    // fall back to checking the selected guild's owner directly.
                    const guildId = SelectedGuildStore?.getGuildId?.();
                    return Boolean(guildId) && GuildStore.getGuild(guildId!)?.ownerId === props.user.id;
                })();
            if (!isOwner) return null;

            return React.createElement("span", {
                className: "limey-ghost-anchor",
                "data-limey-ghost-anchor": "crown",
                "data-user-id": props.user.id,
                "aria-hidden": true,
                style: {
                    display: "inline-block",
                    width: 0,
                    height: 16,
                    verticalAlign: "text-bottom",
                    pointerEvents: "none",
                },
            });
        }, "guilds");
    },

    stop() {
        removeMemberListDecorator("ForceOwnerCrown");
    },
});

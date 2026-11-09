/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
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

import { ApplicationCommandInputType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { LinkIcon } from "@components/Icons";
import type { Channel } from "@limeyV1/discord-types";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { channelLink, LINK_KINDS, LinkKind, makeLink, userLink } from "./links";

const STRING = 3;

function contextOf(channel?: Channel | null) {
    if (!channel?.id) return undefined;
    return { channelId: channel.id, guildId: channel.guild_id ?? undefined };
}

function copyItem(id: string, link: string) {
    return (
        <Menu.MenuItem
            id={id}
            label="Copy protocol link"
            action={() => void copyToClipboard(link)}
            icon={LinkIcon}
            leadingAccessory={{ type: "icon", icon: LinkIcon }}
        />
    );
}

const MessageContextPatch: NavContextMenuPatchCallback = (children, { message, channel }) => {
    if (!message?.id) return;

    const context = contextOf(channel);
    if (!context) return;

    children.push(copyItem("limey-protocol-link-message", channelLink({ ...context, messageId: message.id })));
};

const ChannelContextPatch: NavContextMenuPatchCallback = (children, { channel }) => {
    const context = contextOf(channel);
    if (!context) return;

    children.push(copyItem("limey-protocol-link-channel", channelLink(context)));
};

const UserContextPatch: NavContextMenuPatchCallback = (children, { user }) => {
    if (!user?.id) return;

    children.push(copyItem("limey-protocol-link-user", userLink(user.id)));
};

export default definePlugin({
    name: "ProtocolLinkMaker",
    permissions: [
        {
            id: "registerCommands",
            title: "Register chat commands",
            description: "Adds the /protolink slash command.",
            risk: "The command reads the link or ID you type into it."
        },
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Adds 'Copy protocol link' entries to message, channel and user context menus.",
            risk: "Runs inside your client with full plugin privileges; it only adds menu entries."
        }
    ],
    description: "Turns Discord links, IDs and whatever you're looking at into discord:// protocol links and copies them to your clipboard.",
    tags: ["Utility", "Commands"],
    authors: [Devs.Limey],

    commands: [
        {
            name: "protolink",
            description: "Build a discord:// protocol link and copy it to your clipboard",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "link",
                    description: "Discord link or ID to convert. Leave empty to link to this channel.",
                    type: STRING,
                    required: false
                },
                {
                    name: "type",
                    description: "What a bare ID is: auto, channel, message, user or guild",
                    type: STRING,
                    required: false
                }
            ],
            execute(options, { channel }) {
                const raw = String(findOption(options, "link", "") ?? "");
                const requested = String(findOption(options, "type", "auto") ?? "auto").toLowerCase();
                const kind: LinkKind = LINK_KINDS.includes(requested as LinkKind) ? requested as LinkKind : "auto";

                const result = makeLink(raw, contextOf(channel), kind);
                if (!result.ok) return sendBotMessage(channel.id, { content: `❌ ${result.error}` });

                void copyToClipboard(result.link);
                return sendBotMessage(channel.id, { content: `Copied \`${result.link}\`` });
            }
        }
    ],

    contextMenus: {
        "message-context": MessageContextPatch,
        "channel-context": ChannelContextPatch,
        "user-context": UserContextPatch
    }
});

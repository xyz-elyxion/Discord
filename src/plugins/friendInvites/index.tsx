/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
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

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";

import FriendCodesPanel from "./components/FriendCodesPanel";

const FriendInvites = findByPropsLazy("createFriendInvite");

export default definePlugin({
    name: "FriendInvites",
    permissions: [
        {
            id: "modifyMessages",
            title: "Read and modify messages you send",
            description: "Intercepts messages before sending to transform their content (URLs, prefixes, timestamps, attachments).",
            risk: "Your outgoing message content is processed by this plugin before it reaches Discord."
        },
        {
            id: "registerCommands",
            title: "Register chat commands",
            description: "Adds slash-style commands that can read your input and send messages on your behalf.",
            risk: "Command input and any messages sent through them are handled by this plugin."
        }
    ],
    description: "Create and manage friend invite links via slash commands (/create friend invite, /view friend invites, /revoke friend invites) and adds a Friend Codes panel to the Add Friends page.",
    tags: ["Friends", "Commands"],
    authors: [Devs.afn, Devs.Dziurwa, Devs.domibtnr],
    patches: [
        {
            find: "#{intl::ADD_FRIEND})}),(",
            replacement: {
                match: /\.Fragment,\{children:\[(\(0,\i\.jsx\)\(\i,\{\}\)),(\(0,\i\.jsx\)\(\i,\{\}\))\]/,
                replace: ".Fragment,{children:[$1,$self.FriendCodesPanel,$2]"
            }
        }
    ],

    commands: [
        {
            name: "create friend invite",
            description: "Generates a friend invite link.",
            inputType: ApplicationCommandInputType.BUILT_IN,

            execute: async (args, ctx) => {
                const invite = await FriendInvites.createFriendInvite();

                sendBotMessage(ctx.channel.id, {
                    content: `
                        discord.gg/${invite.code} ·
                        Expires: <t:${Math.round(new Date(invite.expires_at).getTime() / 1000)}:R> ·
                        Max uses: \`${invite.max_uses}\`
                    `.trim().replace(/\s+/g, " ")
                });
            }
        },
        {
            name: "view friend invites",
            description: "View a list of all generated friend invites.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_, ctx) => {
                const invites = await FriendInvites.getAllFriendInvites();
                const friendInviteList = invites.map(i =>
                    `
                    _discord.gg/${i.code}_ ·
                    Expires: <t:${Math.round(new Date(i.expires_at).getTime() / 1000)}:R> ·
                    Times used: \`${i.uses}/${i.max_uses}\`
                    `.trim().replace(/\s+/g, " ")
                );

                sendBotMessage(ctx.channel.id, {
                    content: friendInviteList.join("\n") || "You have no active friend invites!"
                });
            },
        },
        {
            name: "revoke friend invites",
            description: "Revokes all generated friend invites.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_, ctx) => {
                await FriendInvites.revokeFriendInvites();

                sendBotMessage(ctx.channel.id, {
                    content: "All friend invites have been revoked."
                });
            },
        },
    ],

    get FriendCodesPanel() {
        return <FriendCodesPanel />;
    }
});

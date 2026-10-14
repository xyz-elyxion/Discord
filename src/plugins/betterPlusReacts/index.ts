/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { Message } from "@limeyV1/discord-types";
import { MessageStore } from "@webpack/common";

export default definePlugin({
    name: "BetterPlusReacts",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Uses Discord's own events and stores to read the content, authors and attachments of messages you can already see.",
            risk: "A buggy or abused plugin could collect, copy or act on private conversations."
        }
    ],
    authors: [Devs.Joona],
    description: "The amount of plus before :emoji: is the message to add it to",
    tags: ["Chat", "Emotes"],
    patches: [
        {
            find: ".SLASH_COMMAND_USED,",
            replacement: [
                {
                    match: /\\\+/,
                    replace: "$&*"
                },
                {
                    match: /\i.trim\(\)/,
                    replace: "$&.replace(/^\\++/, '+')"
                },
                {
                    match: /=\i\.\i\.getMessages\(\i\.id\)\.last\(\)(?=.{78,85}.getByName\(\i\.)/,
                    replace: "=$self.getMsgReference()"
                }
            ]
        },
        {
            find: "this.props.activeCommandOption,",
            replacement: [
                // Enable auto complete for multiple plusses
                // and set the message reference
                {
                    match: /:this.props.currentWord/,
                    replace: "$&.replace(/^\\++/, '+')"
                },
                {
                    match: /this.props.editorRef.current\)return;/,
                    replace: "$&$self.setMsgReference(this.props.currentWord.split(':')[0],this.props.channel.id);"
                }
            ]
        },
    ],
    message: null as Message | null,
    getMsgReference() {
        const { message } = this;
        this.message = null;
        return message;
    },
    setMsgReference(plusses: string, channelId: string) {
        const { getMessages } = MessageStore;
        // getByIndex/length exist on the runtime ChannelMessages object
        // but are not declared in the type surface.
        const messages = getMessages(channelId) as any;
        this.message = messages.getByIndex(messages.length - plusses.split("+").length + 1) ?? null;
    }
});

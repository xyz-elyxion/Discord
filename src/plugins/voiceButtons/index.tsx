/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import type { User } from "@limeyV1/discord-types";
import { React } from "@webpack/common";

import { settings } from "./settings";
import { UserChatButton, UserDeafenButton, UserMuteButton } from "./utils";

export default definePlugin({
    name: "VoiceButtons",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Quickly DM, mute, or deafen any user right from the voice-call panel.",
    tags: ["Servers", "Utility", "Voice"],
    authors: [Devs.nicola02nb, Devs.omaw],
    settings,
    patches: [
        {
            find: ".VOICE_PANEL}}",
            replacement: [
                {
                    match: /\}\),children:\[(?=.{0,50}#{intl::PRIORITY_SPEAKER})/,
                    replace: "$&$self.renderButtons(arguments[0]?.user),"
                }
            ]
        }
    ],
    renderButtons(user: User) {
        if (!user) return null;
        const positionClass = settings.store.buttonPosition === "right"
            ? "voice-user-buttons-right"
            : "voice-user-buttons-left";

        return (
            <Flex flexDirection="row" className={`voice-user-buttons ${positionClass}`}>
                {settings.store.showChatButton && <UserChatButton user={user} />}
                {settings.store.showMuteButton && <UserMuteButton user={user} />}
                {settings.store.showDeafenButton && <UserDeafenButton user={user} />}
            </Flex>
        );
    }
});

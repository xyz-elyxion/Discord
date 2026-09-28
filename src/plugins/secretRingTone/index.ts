/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2023 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const settings = definePluginSettings({
    onlySnow: {
        type: OptionType.BOOLEAN,
        description: "Only play the Snow Halation Theme",
        default: false,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "SecretRingToneEnabler",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Always play the secret version of the discord ringtone (except during special ringtone events)",
    tags: ["Notifications", "Fun"],
    authors: [Devs.AndrewDLO, Devs.FieryFlames, Devs.RamziAH],
    settings,
    patches: [
        {
            find: '"call_ringing_beat"',
            replacement: [
                {
                    match: /500!==\i\(\)\.random\(1,1e3\)/,
                    replace: "false"
                },
                {
                    predicate: () => settings.store.onlySnow,
                    match: /"call_ringing_beat",/,
                    replace: ""
                }
            ]
        }
    ]
});

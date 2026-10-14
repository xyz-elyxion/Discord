/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByCodeLazy } from "@webpack";

const flashPageTitle = findByCodeLazy("=>({flashQueue:[...");
const rootTitle = { base: null as string | null };

export const settings = definePluginSettings({
    title: {
        type: OptionType.STRING,
        default: "Limey V1",
        description: "Window title prefix"
    },
});

function setTitle(v: string) {
    rootTitle.base = v || null;
    flashPageTitle({ messages: 0 })();
}

export default definePlugin({
    name: "Title",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Replaces the window title prefix",
    tags: ["Customisation"],
    authors: [Devs.Kyuuhachi],
    settings,

    patches: [
        {
            find: 'isPlatformEmbedded?void 0:"Discord"',
            replacement: {
                match: /\{base:\i\("?\d+?"?\)\.isPlatformEmbedded\?void 0:"Discord"\}/,
                replace: "$self.rootTitle",
            },
        },
    ],

    start() {
        setTitle(settings.store.title);
    },

    rootTitle,
});

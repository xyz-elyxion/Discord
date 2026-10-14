/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "NormalizeMessageLinks",
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
    description: "Strip canary/ptb from message links",
    tags: ["Chat"],
    authors: [Devs.bb010g],
    patches: [
        {
            find: "#{intl::COPY_MESSAGE_LINK}",
            replacement: {
                match: /(?<=\/\/\$\{)location\.host/,
                replace: "$self.normalizeHost(location.host)",
            },
        },
    ],
    normalizeHost(host: string) {
        return host.replace(/(^|\b)(canary\.|ptb\.)(discord.com)$/, "$1$3");
    },
});

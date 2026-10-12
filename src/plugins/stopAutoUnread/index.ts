/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "StopAutoUnread",
    description: "Stops Discord from automatically bumping a channel's notification setting to \"All Messages\"",
    tags: ["Notifications"],
    authors: [Devs.SobakinTech],
    patches: [
        {
            find: "}maybeAutoUpgradeChannel(",
            replacement: {
                match: /maybeAutoUpgradeChannel\(\i\){/,
                replace: "$&return !1;"
            }
        }
    ]
});

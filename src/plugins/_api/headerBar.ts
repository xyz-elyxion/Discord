/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "HeaderBarAPI",
    description: "API to add buttons to the header bar and channel toolbar.",
    authors: [Devs.prism],

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(?<="HELP"===.{0,75}\{\}\))(?=\])/,
                replace: ",...LimeyV1.Api.HeaderBar._addHeaderBarButtons()"
            }
        },
        {
            find: "Missing channel in Channel.renderHeaderToolbar",
            replacement: {
                match: /(?<=renderHeaderToolbar"\);let (\i)=\[\];)/,
                replace: "LimeyV1.Api.HeaderBar._addChannelToolbarButtons($1);"
            }
        }
    ]
});

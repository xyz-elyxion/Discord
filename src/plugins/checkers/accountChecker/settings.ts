/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    showUnobtainableHints: {
        type: OptionType.BOOLEAN,
        description: "Highlight badges that can no longer be obtained (strong age/authenticity signal)",
        default: true,
        restartNeeded: false
    }
});

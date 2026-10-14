/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    eliteColor: {
        type: OptionType.STRING,
        description: "Elite Streak Color (100+ days)",
        default: "#9b39fe"
    },
    diamondColor: {
        type: OptionType.STRING,
        description: "Diamond Streak Color (60+ days)",
        default: "#f7409c"
    },
    platinumColor: {
        type: OptionType.STRING,
        description: "Platinum Streak Color (45+ days)",
        default: "#856bfe"
    },
    goldColor: {
        type: OptionType.STRING,
        description: "Gold Streak Color (30+ days)",
        default: "#f75340"
    },
    silverColor: {
        type: OptionType.STRING,
        description: "Silver Streak Color (14+ days)",
        default: "#f57b0b"
    },
    bronzeColor: {
        type: OptionType.STRING,
        description: "Bronze Streak Color (7+ days)",
        default: "#b08d57"
    },
    defaultColor: {
        type: OptionType.STRING,
        description: "Default Streak Color (1+ days)",
        default: "#f59e0b"
    }
});

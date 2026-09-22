/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Command } from "@limeyV1/discord-types";
export { ApplicationCommandInputType, ApplicationCommandOptionType, ApplicationCommandType } from "@limeyV1/discord-types/enums";

export interface LimeyV1Command extends Command {
    isLimeyV1Command?: boolean;
    rootCommand?: LimeyV1Command;
}

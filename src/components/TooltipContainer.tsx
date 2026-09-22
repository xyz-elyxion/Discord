/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TooltipProps } from "@limeyV1/discord-types";
import { Tooltip } from "@webpack/common";

export function TooltipContainer({ children, ...props }: Omit<TooltipProps, "children"> & { children: React.ReactNode; }) {
    return (
        <Tooltip {...props}>
            {tooltipProps =>
                <div {...tooltipProps}>
                    {children}
                </div>
            }
        </Tooltip>
    );
}

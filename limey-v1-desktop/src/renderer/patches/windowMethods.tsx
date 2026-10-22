/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addPatch } from "./shared";

addPatch({
    patches: [
        {
            find: ",setSystemTrayApplications",
            replacement: [
                {
                    match: /\i\.window\.(close|minimize|maximize)/g,
                    replace: `LimeyV1Native.win.$1`
                },
                {
                    match: /(focus(\(\i\)){).{0,150}?\.focus\(\i,\i\)/,
                    replace: "$1LimeyV1Native.win.focus$2"
                },
                {
                    match: /,getEnableHardwareAcceleration/,
                    replace: "$&:LimeyV1Native.app.getEnableHardwareAcceleration,_oldGetEnableHardwareAcceleration"
                }
            ]
        }
    ]
});

/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@vencord/types/webpack/common";

import { SettingsComponent } from "./Settings";
import { LimeyV1SettingsSwitch } from "./LimeyV1SettingsSwitch";

export const AutoStartToggle: SettingsComponent = ({ settings }) => {
    const [autoStartEnabled, setAutoStartEnabled] = useState(LimeyV1DesktopNative.autostart.isEnabled());

    return (
        <>
            <LimeyV1SettingsSwitch
                title="Start With System"
                description="Automatically start Limey V1 Desktop on computer start-up"
                value={autoStartEnabled}
                onChange={async v => {
                    await LimeyV1DesktopNative.autostart[v ? "enable" : "disable"]();
                    setAutoStartEnabled(v);
                }}
            />

            <LimeyV1SettingsSwitch
                title="Auto Start Minimized"
                description={"Start Limey V1 Desktop minimized when starting with system"}
                value={settings.autoStartMinimized}
                onChange={v => (settings.autoStartMinimized = v)}
                disabled={!autoStartEnabled}
            />
        </>
    );
};

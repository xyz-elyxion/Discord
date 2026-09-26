/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Guild } from "@limeyV1/discord-types";
import { Modal } from "@webpack/common";

import { SERVER_CONFIGURABLE_PLUGINS } from "./index";

interface Props {
    modalProps: Record<string, any>;
    guild: Guild;
    disabledPlugins: string[];
    onToggle(pluginName: string, value: boolean): void;
}

const PLUGIN_DESCRIPTIONS: Record<string, string> = {
    ShowHiddenThings: "Shows hidden & moderator-only things (timeout icons, invites paused, mod view) regardless of permissions."
};

export function ServerConfigModal({ modalProps, guild, disabledPlugins, onToggle }: Props) {
    return (
        <Modal
            transitionState={modalProps.transitionState}
            onClose={modalProps.onClose}
            size="md"
            title={`${guild.name} — Server Configuration`}
        >
            <div style={{ padding: "8px 16px 16px" }}>
                <Paragraph>
                    Disable Limey V1 plugins that affect this server. Changes apply while members are in this server.
                </Paragraph>

                {SERVER_CONFIGURABLE_PLUGINS.map(name => {
                    return (
                        <FormSwitch
                            key={name}
                            title={name}
                            description={
                                <div>
                                    {PLUGIN_DESCRIPTIONS[name] ?? ""}
                                </div>
                            }
                            value={!disabledPlugins.includes(name)}
                            onChange={v => onToggle(name, v)}
                        />
                    );
                })}
            </div>
        </Modal>
    );
}

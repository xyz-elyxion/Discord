/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useState } from "@webpack/common";

import { FormSwitch } from "@components/FormSwitch";
import { Paragraph } from "@components/Paragraph";
import { Guild } from "@limeyV1/discord-types";
import { Modal, showToast, Toasts } from "@webpack/common";

import { authorize, Auth } from "./auth";
import { SERVER_CONFIGURABLE_PLUGINS } from "./index";

interface Props {
    modalProps: Record<string, any>;
    guild: Guild;
    disabledPlugins: string[];
    onToggle(pluginName: string, value: boolean): Promise<string | null> | void;
}

const PLUGIN_DESCRIPTIONS: Record<string, string> = {
    ShowHiddenThings: "Shows hidden & moderator-only things (timeout icons, invites paused, mod view) regardless of permissions.",
    ShowHiddenChannels: "Shows channels that you do not have access to view."
};

export function ServerConfigModal({ modalProps, guild, disabledPlugins, onToggle }: Props) {
    const [error, setError] = useState<string | null>(null);
    const [authed, setAuthed] = useState(Boolean(Auth.token));

    const handleToggle = async (name: string, value: boolean) => {
        const result = await onToggle(name, value);
        if (result) {
            setError(result);
            showToast(result, Toasts.Type.FAILURE);
        } else {
            setError(null);
        }
    };

    return (
        <Modal
            transitionState={modalProps.transitionState}
            onClose={modalProps.onClose}
            size="md"
            title={`${guild.name} — Server Configuration`}
        >
            <div style={{ padding: "8px 16px 16px" }}>
                <Paragraph>
                    Disable Limey V1 plugins that affect this server. Changes are saved to the Limey backend
                    and respected by every member using Limey V1.
                </Paragraph>

                {!authed && (
                    <Paragraph>
                        <strong>
                            Authorize with Discord to sync changes:
                        </strong>{" "}
                        <a
                            href="#"
                            onClick={e => {
                                e.preventDefault();
                                authorize(() => setAuthed(true));
                            }}
                        >
                            Log in with Discord
                        </a>
                    </Paragraph>
                )}

                {error && (
                    <Paragraph>
                        <strong style={{ color: "var(--text-danger)" }}>{error}</strong>
                    </Paragraph>
                )}

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
                            onChange={v => handleToggle(name, v)}
                        />
                    );
                })}
            </div>
        </Modal>
    );
}

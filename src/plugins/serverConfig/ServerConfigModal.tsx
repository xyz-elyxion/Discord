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

import { authorize, Auth, clearAuth } from "./auth";
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

export function ServerConfigModal({ modalProps, guild, disabledPlugins: initialDisabled, onToggle }: Props) {
    const [disabledPlugins, setDisabledPlugins] = useState<string[]>(initialDisabled);
    const [error, setError] = useState<string | null>(null);
    const [authed, setAuthed] = useState(Boolean(Auth.token));
    const [needsReauth, setNeedsReauth] = useState(false);

    const handleToggle = async (name: string, value: boolean) => {
        // Optimistically update the switch; revert if the backend rejects it
        setDisabledPlugins(prev =>
            value ? prev.filter(p => p !== name) : [...prev, name]
        );
        const result = await onToggle(name, value);
        if (result) {
            setDisabledPlugins(prev =>
                value ? [...prev, name] : prev.filter(p => p !== name)
            );
            setError(result);
            showToast(result, Toasts.Type.FAILURE);
            if (/authoriz|token|log(ged)? in|owner|permission/i.test(result)) {
                setNeedsReauth(true);
            }
        } else {
            setError(null);
            setNeedsReauth(false);
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

                {authed && needsReauth && (
                    <Paragraph>
                        <strong>
                            Your Discord authorization is missing or outdated:
                        </strong>{" "}
                        <a
                            href="#"
                            onClick={e => {
                                e.preventDefault();
                                void clearAuth().then(() => {
                                    authorize(() => {
                                        setAuthed(true);
                                        setNeedsReauth(false);
                                    });
                                });
                            }}
                        >
                            Re-authorize with Discord
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

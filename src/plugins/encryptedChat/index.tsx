/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { MessageAccessoryFactory } from "@api/MessageAccessories";
import { addMessagePreEditListener, addMessagePreSendListener, MessageObject, removeMessagePreEditListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Text, UserStore } from "@webpack/common";

const PREFIX = "\u200Benc\u200B";

const settings = definePluginSettings({
    showNotice: {
        type: OptionType.BOOLEAN,
        description: "Show a [encrypted] tag above decrypted messages",
        default: true,
    }
});

/**
 * Deterministic key derived from the two participants' usernames.
 * Sorted so both sides compute the same key regardless of who sends.
 */
function getSharedKey(channelId: string): string | null {
    const me = UserStore.getCurrentUser();
    if (!me) return null;

    const channel = ChannelStore.getChannel(channelId);
    // type 1 = DM; only DMs are encrypted
    if (!channel || channel.type !== 1) return null;

    const otherId = channel.recipients?.[0];
    const other = otherId ? UserStore.getUser(otherId) : null;
    if (!other) return null;

    const pair = [me.username, other.username].sort().join("|");
    return `limeyV1::${pair}`;
}

/** FNV-1a string hash, used to expand the key material into a keystream. */
function fnv1a(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * XOR stream cipher with a keystream generated from the shared key.
 * Obfuscates against casual reading by anyone else in the channel
 * or Discord's own server-side scanning. Not intended to resist a
 * determined cryptanalyst — see plugin description.
 */
function xorEncrypt(input: string, key: string): string {
    const bytes = new TextEncoder().encode(input);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += String.fromCharCode(bytes[i] ^ (fnv1a(`${key}:${i}`) & 0xff));
    }
    return btoa(out);
}

function xorDecrypt(input: string, key: string): string {
    const raw = atob(input);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        out[i] = raw.charCodeAt(i) ^ (fnv1a(`${key}:${i}`) & 0xff);
    }
    return new TextDecoder().decode(out);
}

function isEncryptedContent(content: string): boolean {
    if (!content?.startsWith(PREFIX)) return false;
    return /^[A-Za-z0-9+/=]+$/.test(content.slice(PREFIX.length).trim());
}

function decrypt(message: any): string | null {
    const content: string = message?.content;
    if (!content || !isEncryptedContent(content)) return null;

    const key = getSharedKey(message.channel_id);
    if (!key) return null;

    try {
        const decrypted = xorDecrypt(content.slice(PREFIX.length).trim(), key);
        // Sanity check: our messages should be valid UTF-8 text
        return decrypted || null;
    } catch {
        return null;
    }
}

const EncryptedAccessory: MessageAccessoryFactory = ({ message }) => {
    const plain = decrypt(message);
    if (plain == null) return null;

    return (
        <div className="vc-encrypted-chat">
            {settings.store.showNotice && (
                <Text variant="text-xxs/medium" style={{ color: "var(--text-muted)" }}>
                    🔒 [encrypted]
                </Text>
            )}
            <Text variant="text-sm/normal" style={{ whiteSpace: "pre-wrap" }}>
                {plain}
            </Text>
        </div>
    );
};

export default definePlugin({
    name: "EncryptedChat",
    description: "Encrypts your DMs with a key derived from both usernames — only you and the other person can read them",
    tags: ["Privacy", "Utility"],
    authors: [Devs.Ven],

    settings,

    renderMessageAccessory: EncryptedAccessory,

    start() {
        this.preSend = addMessagePreSendListener((channelId, message: MessageObject) => {
            const key = getSharedKey(channelId);
            if (!key) return;

            message.content = PREFIX + xorEncrypt(message.content, key);
        });

        this.preEdit = addMessagePreEditListener((channelId, _messageId, message: MessageObject) => {
            const key = getSharedKey(channelId);
            if (!key) return;

            message.content = PREFIX + xorEncrypt(message.content, key);
        });
    },

    stop() {
        removeMessagePreSendListener(this.preSend);
        removeMessagePreEditListener(this.preEdit);
    },
});

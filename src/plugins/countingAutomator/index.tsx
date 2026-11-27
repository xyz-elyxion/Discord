/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Channel } from "@limeyV1/discord-types";
import { Devs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import {
    Menu,
    MessageStore,
    Modal,
    openModal,
    showToast,
    TextInput,
    UserStore,
    useState } from "@webpack/common";

interface ChannelState {
    /** The number the channel should see next. */
    next: number;
    updatedAt: number;
}

interface PendingCount {
    channelId: string;
    expected: number;
    /** The message whose number we are counting on, so a delete can cancel the send. */
    basedOn: string;
}

const STATE_KEY = "CountingAutomator_state_v1";

let states: Record<string, ChannelState> = {};
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let pending: PendingCount | null = null;

const settings = definePluginSettings({
    mode: {
        type: OptionType.SELECT,
        description: "What to do when it is your turn to count",
        options: [
            { label: "Send the next number for me", value: "send", default: true },
            { label: "Only tell me the next number", value: "assist" },
        ],
    },
    delay: {
        type: OptionType.SLIDER,
        description: "How many seconds to wait before sending, so the count does not look instant",
        markers: [1, 2, 3, 5, 8, 10, 15, 30, 60],
        stickToMarkers: false,
        default: 3,
    },
    channelId: {
        type: OptionType.STRING,
        description: "The channel being counted in — set it from that channel's right-click menu",
        default: "",
    },
});

function parseCount(content: string | null | undefined): number | null {
    if (!content) return null;

    // Numbers in counting channels are sometimes bolded or wrapped in backticks.
    const cleaned = content.trim().replace(/^[*_~`]+|[*_~`]+$/g, "").trim();
    if (!/^\d+$/.test(cleaned)) return null;

    const value = Number(cleaned);
    return Number.isSafeInteger(value) ? value : null;
}

function save() {
    void DataStore.set(STATE_KEY, states);
}

function lastCountInChannel(channelId: string): number | null {
    const messages = MessageStore.getMessages(channelId)?._array;
    if (!Array.isArray(messages)) return null;

    for (let index = messages.length - 1; index >= 0; index--) {
        const value = parseCount(messages[index]?.content);
        if (value != null) return value;
    }

    return null;
}

/** Loads the saved position for a channel, scanning its history the first time. */
function ensureState(channelId: string): ChannelState {
    let state = states[channelId];

    if (!state) {
        const last = lastCountInChannel(channelId);
        state = { next: last == null ? 1 : last + 1, updatedAt: Date.now() };
        states[channelId] = state;
        save();
    }

    return state;
}

function setNext(channelId: string, next: number) {
    states[channelId] = { next, updatedAt: Date.now() };
    save();
}

function cancelPending() {
    if (sendTimer != null) clearTimeout(sendTimer);
    sendTimer = undefined;
    pending = null;
}

function delayMs() {
    const seconds = Number(settings.store.delay) || 3;
    // A little jitter keeps the gap between counts from looking mechanical.
    return Math.round(seconds * 1000 * (0.8 + Math.random() * 0.4));
}

async function sendNext(channelId: string) {
    const state = states[channelId];
    if (!state) return;

    const value = state.next;

    try {
        await sendMessage(channelId, { content: String(value) });
        setNext(channelId, value + 1);
    } catch (error) {
        console.error("[CountingAutomator] Could not send the next count", error);
        showToast("Counting Automator couldn't send the next number", "failure");
    }
}

function scheduleSend(channelId: string, expected: number, basedOn: string) {
    cancelPending();
    pending = { channelId, expected, basedOn };

    sendTimer = setTimeout(() => {
        sendTimer = undefined;
        const current = pending;
        pending = null;

        if (!current || settings.store.channelId !== current.channelId) return;

        // Someone else may have counted while we waited; only send if it is still our turn.
        if (states[current.channelId]?.next !== current.expected) return;

        void sendNext(current.channelId);
    }, delayMs());
}

function toggleChannel(channel: Channel) {
    if (settings.store.channelId === channel.id) {
        settings.store.channelId = "";
        cancelPending();
        save();
        showToast("Counting Automator is off", "success");
        return;
    }

    settings.store.channelId = channel.id;
    cancelPending();
    const state = ensureState(channel.id);
    showToast(`Counting in #${channel.name} — next number is ${state.next}`, "success");
}

function NextNumberEditor({ channelId, onDone }: { channelId: string; onDone: () => void; }) {
    const [value, setValue] = useState(String(states[channelId]?.next ?? 1));

    return (
        <div style={{ display: "flex", gap: "0.5em", alignItems: "center" }}>
            <div style={{ flex: 1 }}>
                <TextInput
                    value={value}
                    onChange={setValue}
                    placeholder="1"
                />
            </div>
            <Button
                onClick={() => {
                    const next = Number.parseFloat(value);
                    if (!Number.isSafeInteger(next)) {
                        showToast("That is not a whole number", "failure");
                        return;
                    }
                    setNext(channelId, next);
                    onDone();
                }}
            >
                Save
            </Button>
        </div>
    );
}

function openNextNumberModal(channel: Channel) {
    openModal(props => (
        <Modal
            {...props}
            title="Counting Automator"
            subtitle={`The next number to send in #${channel.name}`}
        >
            <NextNumberEditor
                channelId={channel.id}
                onDone={() => props.onClose()}
            />
        </Modal>
    ));
}

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel?.guild_id) return;

    const enabled = settings.store.channelId === channel.id;
    const next = states[channel.id]?.next;

    children.push(
        <Menu.MenuItem id="counting-automator" label="Counting Automator">
            <Menu.MenuItem
                id="counting-automator-toggle"
                label={enabled ? "Turn off in this channel" : "Count in this channel"}
                action={() => toggleChannel(channel)}
            />
            <Menu.MenuItem
                id="counting-automator-set"
                label="Set the next number…"
                action={() => openNextNumberModal(channel)}
            />
            <Menu.MenuItem
                id="counting-automator-send"
                label={next == null ? "Send the next number now" : `Send the next number now (${next})`}
                disabled={!enabled || next == null}
                action={() => void sendNext(channel.id)}
            />
        </Menu.MenuItem>
    );
};

export default definePlugin({
    name: "CountingAutomator",
    description: "Keeps the count in a counting channel for you: it follows the last number, then either sends the next one or just tells you what it is.",
    tags: ["Chat", "Utility"],
    authors: [Devs.Limey],
    permissions: [
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Reads the numbers posted in the channel you point it at, to work out what comes next.",
            risk: "Only messages in the configured channel are inspected, and only to parse a number.",
        },
        {
            id: "sendMessage",
            title: "Send messages as you",
            description: "Posts the next number in the configured channel when you have it turned on.",
            risk: "An automated count is still a message from your account — leave it off in servers where that is not welcome.",
        },
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Remembers the count per channel so it survives a restart.",
            risk: "The channel ID and number are kept in the client's local DataStore on your device.",
        },
    ],
    settings,

    contextMenus: {
        "channel-context": patchChannelContextMenu,
    },

    toolboxActions: {
        "Counting Automator: send the next number"() {
            const { channelId } = settings.store;
            if (!channelId) {
                showToast("Pick a counting channel from its right-click menu first", "failure");
                return;
            }
            void sendNext(channelId);
        },
    },

    flux: {
        MESSAGE_CREATE({ message, channelId, optimistic, type }: { message: any; channelId: string; optimistic: boolean; type: string; }) {
            if (optimistic || type !== "MESSAGE_CREATE" || message?.state === "SENDING") return;
            if (!settings.store.channelId || channelId !== settings.store.channelId) return;
            if (!message?.author || message.author.id === UserStore.getCurrentUser()?.id) return;

            const value = parseCount(message.content);
            if (value == null) return;

            // Whatever number just landed is the truth, even after a reset.
            setNext(channelId, value + 1);

            if (settings.store.mode === "assist") {
                showToast(`Next count: ${value + 1}`, "message");
                return;
            }

            scheduleSend(channelId, value + 1, message.id);
        },

        MESSAGE_DELETE({ id, channelId }: { id: string; channelId: string; }) {
            if (!pending || pending.channelId !== channelId || pending.basedOn !== id) return;

            // The count we were about to follow got deleted (usually by the counting bot).
            cancelPending();
            showToast("That count was deleted — waiting for the next one", "message");
        },
    },

    async start() {
        const stored = await DataStore.get<Record<string, ChannelState>>(STATE_KEY);
        if (stored && typeof stored === "object") states = stored;
    },

    stop() {
        cancelPending();
    },
});

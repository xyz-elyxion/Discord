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

import * as DataStore from "@api/DataStore";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { DeleteIcon, PlusIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { TextInput, useState } from "@webpack/common";

interface RotationEntry {
    text: string;
    /** Minutes this status stays up. Raw string while the user is typing. */
    minutes: number | string;
}

const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 1;
const MAX_MINUTES = 24 * 60;
const STATE_KEY = "StatusRotator_origin_v1";

const CustomStatusSettings = getUserSettingLazy("status", "customStatus")!;

let timer: ReturnType<typeof setTimeout> | undefined;
let originAt = 0;
let appliedIndex = -1;
let listening = false;

function clampMinutes(value: unknown) {
    const minutes = Math.round(Number(value));

    if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_MINUTES;

    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
}

/** The settings list as the user typed it, so empty rows survive while editing. */
function getStoredEntries(): RotationEntry[] {
    const stored = settings.store.entries as RotationEntry[] | undefined;

    return (stored ?? []).map(entry => ({
        text: String(entry?.text ?? ""),
        minutes: entry?.minutes ?? DEFAULT_MINUTES,
    }));
}

/** The entries that can actually be applied. */
function getEntries(): RotationEntry[] {
    return getStoredEntries()
        .map(entry => ({ text: entry.text.trim(), minutes: clampMinutes(entry.minutes) }))
        .filter(entry => entry.text.length > 0);
}

/**
 * Which entry the wall clock says should be up, and how long it has left.
 * Deriving the position from an origin timestamp keeps the rotation correct
 * across restarts and after the machine sleeps through several slots.
 */
function entryAt(entries: RotationEntry[], elapsedMs: number) {
    const cycleMs = entries.reduce((total, entry) => total + clampMinutes(entry.minutes) * 60_000, 0);
    let offset = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;

    for (let index = 0; index < entries.length; index++) {
        const span = clampMinutes(entries[index].minutes) * 60_000;
        if (offset < span) return { index, remainingMs: span - offset };
        offset -= span;
    }

    return { index: 0, remainingMs: clampMinutes(entries[0].minutes) * 60_000 };
}

function applyEntry(entry: RotationEntry) {
    const current = CustomStatusSettings.getSetting();
    if (current?.text === entry.text) return;

    CustomStatusSettings.updateSetting({
        text: entry.text,
        emojiId: "0",
        emojiName: "",
        expiresAtMs: "0",
        createdAtMs: String(Date.now()),
    });
}

function clearTimer() {
    if (timer != null) clearTimeout(timer);
    timer = undefined;
}

function persistOrigin() {
    void DataStore.set(STATE_KEY, originAt);
}

function sync(force = false) {
    clearTimer();

    const entries = getEntries();
    if (!entries.length || !settings.store.autoRotate) return;

    if (!originAt) originAt = Date.now();

    const { index, remainingMs } = entryAt(entries, Date.now() - originAt);

    if (force || index !== appliedIndex) {
        applyEntry(entries[index]);
        appliedIndex = index;
    }

    timer = setTimeout(() => sync(true), Math.max(1_000, remainingMs + 250));
}

/** Jump to the next status right away and restart its countdown. */
function advanceNow() {
    const entries = getEntries();
    if (!entries.length) return;

    if (!originAt) originAt = Date.now();

    const { index } = entryAt(entries, Date.now() - originAt);
    const nextIndex = (index + 1) % entries.length;
    const offset = entries
        .slice(0, nextIndex)
        .reduce((total, entry) => total + clampMinutes(entry.minutes) * 60_000, 0);

    originAt = Date.now() - offset;
    appliedIndex = -1;
    persistOrigin();
    sync(true);
}

/** Start the cycle over from the first status. */
function restartRotation() {
    originAt = Date.now();
    appliedIndex = -1;
    persistOrigin();
    sync(true);
}

function EntriesComponent() {
    const [entries, setEntries] = useState<RotationEntry[]>(getStoredEntries);

    const update = (next: RotationEntry[]) => {
        setEntries(next);
        settings.store.entries = next;
    };

    return (
        <section>
            <Heading>Statuses</Heading>
            <Paragraph>
                Each status becomes your Discord custom status for the number of minutes beside it, in order, and then
                the next one takes over. Use the “Rotate status now” toolbox action to skip ahead.
            </Paragraph>
            {entries.length === 0 && (
                <Paragraph>No statuses yet — add one below to start the rotation.</Paragraph>
            )}
            {entries.map((entry, index) => (
                <div
                    key={index}
                    style={{ display: "flex", gap: "0.5em", alignItems: "center", margin: "0.5em 0" }}
                >
                    <div style={{ flex: 1 }}>
                        <TextInput
                            value={entry.text}
                            onChange={value => update(entries.map((x, i) => i === index ? { ...x, text: value } : x))}
                            placeholder="Status text"
                        />
                    </div>
                    <div style={{ width: "7em" }}>
                        <TextInput
                            type="number"
                            value={String(entry.minutes)}
                            onChange={value => update(entries.map((x, i) => i === index ? { ...x, minutes: value } : x))}
                            placeholder={String(DEFAULT_MINUTES)}
                        />
                    </div>
                    <Button
                        variant="dangerSecondary"
                        size="iconOnly"
                        aria-label="Remove status"
                        onClick={() => update(entries.filter((_, i) => i !== index))}
                    >
                        <DeleteIcon width={20} height={20} />
                    </Button>
                </div>
            ))}
            <div style={{ display: "flex", gap: "0.5em", marginTop: "0.5em" }}>
                <Button
                    variant="secondary"
                    onClick={() => update([...entries, { text: "", minutes: DEFAULT_MINUTES }])}
                >
                    <PlusIcon /> Add status
                </Button>
                <Button variant="secondary" disabled={entries.length === 0} onClick={restartRotation}>
                    Restart from the first status
                </Button>
            </div>
        </section>
    );
}

const settings = definePluginSettings({
    entries: {
        type: OptionType.COMPONENT,
        description: "The statuses to rotate through",
        component: EntriesComponent,
        default: [] as RotationEntry[],
    },
    autoRotate: {
        type: OptionType.BOOLEAN,
        description: "Switch statuses automatically. Turn this off to keep the list without touching your status.",
        default: true,
    },
});

const onSettingsChange = () => sync();

export default definePlugin({
    name: "StatusRotator",
    description: "Cycles your custom status through a list you write, for a set time each — for work hours, streams or shifts.",
    tags: ["Activity", "Customisation", "Utility"],
    authors: [Devs.Limey],
    permissions: [
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Remembers where in the rotation you are so it picks up where it left off after a restart.",
            risk: "The rotation origin is kept in the client's local DataStore on your device.",
        },
    ],
    settings,

    toolboxActions: {
        "Rotate status now": advanceNow,
    },

    async start() {
        const stored = await DataStore.get<number>(STATE_KEY);
        originAt = typeof stored === "number" && Number.isFinite(stored) ? stored : Date.now();

        SettingsStore.addPrefixChangeListener("plugins.StatusRotator", onSettingsChange);
        listening = true;

        sync(true);
    },

    stop() {
        clearTimer();

        if (listening) {
            SettingsStore.removePrefixChangeListener("plugins.StatusRotator", onSettingsChange);
            listening = false;
        }

        appliedIndex = -1;
    },
});

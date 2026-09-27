/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { zustandCreate, zustandPersist } from "@webpack/common";

import { indexedDBStorageFactory } from "../utils";
import { ForumChannelStore, ForumChannelStoreCreator, ForumChannelStoreState } from "./types";

const STORAGE_KEY = "BetterForums";

// Storing Sets directly might cause data corruption during json stringification
function partialize({ channelStates }: ForumChannelStore): ForumChannelStoreState {
    const states = Object.fromEntries(
        Object.entries(channelStates).map(([id, state]) => [id, { ...state, tagFilter: [...state.tagFilter] }])
    );

    return { channelStates: states };
}

function merge({ channelStates }: ForumChannelStoreState, current: ForumChannelStore): ForumChannelStore {
    for (const [id, state] of Object.entries(channelStates)) {
        current.channelStates[id] = { ...state, tagFilter: new Set(state.tagFilter) };
    }

    return current;
}

export function initializeStore(storeCreator: ForumChannelStoreCreator): () => ForumChannelStore {
    return zustandCreate(
        zustandPersist(storeCreator, {
            name: `${STORAGE_KEY}-state`,
            storage: indexedDBStorageFactory<ForumChannelStoreState>(),
            partialize,
            merge
        })
    );
}

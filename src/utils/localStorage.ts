/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
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

/**
 * Userscript sandboxes (Tampermonkey, Greasemonkey, ...) may expose a `window.localStorage`
 * that is `undefined`, or one that throws `SecurityError` just for being touched. Both used
 * to crash the bundle at import time or every settings read/write afterwards. Probe the real
 * storage instead of blindly trusting `window.localStorage`, and degrade to an in-memory shim
 * so Limey V1 always keeps loading: with the shim, data lives for the current session only.
 */

function getRealLocalStorage(): Storage | null {
    try {
        const ls = window.localStorage;
        if (!ls) return null;
        // Probe: some contexts hand out a Storage object that throws on first use
        const probe = "__limeyV1LocalStorageProbe";
        ls.setItem(probe, "1");
        ls.removeItem(probe);
        return ls;
    } catch {
        return null;
    }
}

function createMemoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() { return map.size; },
        clear() { map.clear(); },
        getItem(key) {
            return map.has(key) ? map.get(key)! : null;
        },
        key(index) {
            return [...map.keys()][index] ?? null;
        },
        removeItem(key) {
            map.delete(key);
        },
        setItem(key, value) {
            map.set(key, String(value));
        }
    };
}

const realStorage = getRealLocalStorage();

export const localStorage: Storage = realStorage ?? (() => {
    console.warn("Limey V1: window.localStorage is unavailable in this context; falling back to volatile in-memory storage (data will not persist across reloads).");
    return createMemoryStorage();
})();

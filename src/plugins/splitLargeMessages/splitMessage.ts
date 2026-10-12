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

export type SplitMode = "characters" | "spaces" | "newlines";

function findSplitIndex(content: string, limit: number, mode: SplitMode): number {
    if (mode === "characters") return limit;

    const boundary = mode === "newlines" ? "\n" : " ";
    const preferredBoundary = content.lastIndexOf(boundary, limit - 1);

    if (preferredBoundary > 0) return preferredBoundary + boundary.length;
    if (mode === "newlines") {
        const spaceBoundary = content.lastIndexOf(" ", limit - 1);
        if (spaceBoundary > 0) return spaceBoundary + 1;
    }

    return limit;
}

// each returned chunk is at most `limit` UTF-16 code units, matching discord's limit.
export function splitMessage(content: string, limit: number, mode: SplitMode): string[] {
    if (limit < 1) return [];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > limit) {
        const splitIndex = findSplitIndex(remaining, limit, mode);
        chunks.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex);
    }

    if (remaining) chunks.push(remaining);
    return chunks;
}

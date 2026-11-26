/** Shared response formatting: character budget, byte sizes, pagination. */

export const CHARACTER_LIMIT = 25_000;

export interface ClippedText {
    text: string;
    truncated: boolean;
}

export function clip(text: string, limit = CHARACTER_LIMIT): ClippedText {
    if (text.length <= limit) return { text, truncated: false };

    return {
        text: `${text.slice(0, limit)}\n\n… cut off after ${limit.toLocaleString("en")} characters of ${text.length.toLocaleString("en")}.`,
        truncated: true
    };
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Keeps a page under the character budget by returning fewer items, never by cutting text.
 * The caller's render callback sees the shortened item list, so counts and next offsets match
 * what is actually sent.
 */
export function paginate<T>(
    items: T[],
    render: (items: T[]) => { page: Record<string, unknown>; text: string; }
): { page: Record<string, unknown>; text: string; shown: T[]; } {
    let shown = items;
    let result = render(shown);

    while (shown.length > 1 && result.text.length > CHARACTER_LIMIT) {
        shown = shown.slice(0, Math.ceil(shown.length / 2));
        result = render(shown);
    }

    return { ...result, shown };
}

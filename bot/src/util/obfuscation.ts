/*
 * Private Channel Obfuscation support.
 *
 * Starting November 16, 2026 (or earlier when opted in via the Developer
 * Portal toggle), Discord obfuscates guild channels the bot lacks
 * VIEW_CHANNEL for:
 *   - the name is replaced with a placeholder ("___hidden___")
 *   - sensitive fields (topic, nsfw, overwrites beyond a single @everyone
 *     deny, etc.) are nulled or replaced with placeholder values
 *   - the ID, type, position and parent ID remain intact
 * The REST API omits obfuscated channels entirely; they only appear via the
 * gateway. The only reliable detection is the OBFUSCATED channel flag
 * (1 << 17), but our oceanic version doesn't expose it yet, so we also
 * detect the documented placeholder name and the tell-tale single @everyone
 * VIEW_CHANNEL-deny overwrite.
 *
 * Code that lists or resolves channels should skip obfuscated channels: the
 * bot cannot read or send there anyway, and showing "___hidden___" to
 * dashboard users leaks nothing useful and confuses pickers.
 */

import type { AnyGuildChannelWithoutThreads, Guild } from "oceanic.js";

export const CHANNEL_OBFUSCATED_FLAG = 1n << 17n;
export const OBFUSCATED_NAME_PLACEHOLDER = "___hidden___";

/** True when the given cached guild channel is obfuscated. */
export function isChannelObfuscated(channel: AnyGuildChannelWithoutThreads): boolean {
    const raw = channel as unknown as { flags?: number };
    if (typeof raw.flags === "number" && (BigInt(raw.flags) & CHANNEL_OBFUSCATED_FLAG) !== 0n) return true;
    if (channel.name === OBFUSCATED_NAME_PLACEHOLDER) return true;
    // Fallback: exactly one overwrite, for the @everyone role, denying VIEW_CHANNEL (1 << 10)
    const overwrites = [...(channel.permissionOverwrites?.values() ?? [])];
    if (
        overwrites.length === 1 &&
        overwrites[0].type === 0 &&
        overwrites[0].id === channel.guildID &&
        (overwrites[0].deny & (1n << 10n)) !== 0n
    ) return true;
    return false;
}

/** Channels of the guild the bot can actually see (obfuscated ones filtered out). */
export function getVisibleChannels(guild: Guild): AnyGuildChannelWithoutThreads[] {
    return [...guild.channels.values()].filter(c => !isChannelObfuscated(c));
}

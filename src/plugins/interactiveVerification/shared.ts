// Fallback (home guild) channel used when the guild has no site config yet
export const VERIFICATION_CHANNEL_ID = "1554636290211971092";
export const RULES_CHANNEL_ID = "1553937108107006043";

// Per-guild verification configs, loaded from the site API:
//   GET https://<site>/v1/verify/guilds/<guildId> -> { channelId, rulesChannelId, roleId }
// Populated lazily by index.tsx on channel select and kept in a short cache.
export const guildVerifyConfigs = new Map<string, { channelId: string; rulesChannelId: string | null; roleId: string | null }>();

// same-origin in production (server.js proxies /v1/verify/*), direct in dev
export const API_BASE = typeof window !== "undefined" && !["3000", "10000", ""].includes(window.location.port)
    ? "http://127.0.0.1:8152"
    : "";

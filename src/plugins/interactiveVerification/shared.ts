export const VERIFICATION_CHANNEL_ID = "1554636290211971092";
export const RULES_CHANNEL_ID = "1553937108107006043";

// same-origin in production (server.js proxies /v1/verify/*), direct in dev
export const API_BASE = typeof window !== "undefined" && !["3000", "10000", ""].includes(window.location.port)
    ? "http://127.0.0.1:8152"
    : "";

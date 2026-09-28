// Enabled proxies are passed to the bot via env; the bot round-robins them.
function buildLimebotProxyEnv() {
    const enabled = proxies.list.filter(p => p.enabled !== false);
    if (!enabled.length) return {};
    console.log(`[limebot] routing Discord API traffic through ${enabled.length} prox${enabled.length === 1 ? "y" : "ies"}`);
    if (enabled.length === 1) return { LIMEBOT_PROXY: enabled[0].url };
    return { LIMEBOT_PROXIES_JSON: JSON.stringify(enabled.map(p => p.url)) };
}

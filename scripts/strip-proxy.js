const fs = require("fs");
const p = require("path").join(__dirname, "..", "server.js");
let s = fs.readFileSync(p, "utf8");

function cut(startMarker, endMarker) {
    const i = s.indexOf(startMarker);
    if (i === -1) { console.error("MISS start:", startMarker.slice(0, 60)); process.exit(1); }
    const j = s.indexOf(endMarker, i);
    if (j === -1) { console.error("MISS end:", endMarker.slice(0, 60)); process.exit(1); }
    s = s.slice(0, i) + s.slice(j + endMarker.length);
}

// 1. Proxy store + testProxy block (from the comment header to nextToken)
cut("// ------------------------------------------------------------------\n// Proxy pool", "function nextToken(provider)");

// 2. hydrateKv proxy entries
s = s.replace(`        const [usrbg, aiTokens, detector, reviewdbData, badges, proxyData] = await Promise.all([
            kvGet("limey:usrbg"),
            kvGet("limey:ai-tokens"),
            kvGet("limey:detector"),
            kvGet("limey:reviewdb"),
            kvGet("limey:badges"),
            kvGet("limey:proxies")
        ]);
        if (usrbg) usrbgData = JSON.parse(usrbg);
        if (proxyData) {
            const parsed = JSON.parse(proxyData);
            if (Array.isArray(parsed.proxies)) proxiesData = { proxies: parsed.proxies };
        }
`, `        const [usrbg, aiTokens, detector, reviewdbData, badges] = await Promise.all([
            kvGet("limey:usrbg"),
            kvGet("limey:ai-tokens"),
            kvGet("limey:detector"),
            kvGet("limey:reviewdb"),
            kvGet("limey:badges")
        ]);
        if (usrbg) usrbgData = JSON.parse(usrbg);
`);

// 3. Proxy admin endpoints block: from the proxy pool comment to the final 404 of handleAdmin
cut("    // ------------------------- proxy pool -------------------------", "    return json(res, 404, { error: \"not found\" }), true;\n}\n\n// Returns true if the request was handled by the usrbg API");

// 4. buildLimebotProxyEnv + env passthrough
s = s.replace(`// Enabled proxies are passed to the bot via env; the bot round-robins them.
function buildLimebotProxyEnv() {
    const enabled = proxies.list.filter(p => p.enabled !== false);
    if (!enabled.length) return {};
    console.log(\`[limebot] routing Discord API traffic through \${enabled.length} prox\${enabled.length === 1 ? "y" : "ies"}\`);
    if (enabled.length === 1) return { LIMEBOT_PROXY: enabled[0].url };
    return { LIMEBOT_PROXIES_JSON: JSON.stringify(enabled.map(p => p.url)) };
}

`, "");
s = s.replace('env: { ...process.env, LIMEBOT: "1", LIMEBOT_ADMIN_TOKEN: process.env.USRBG_ADMIN_TOKEN, ...buildLimebotProxyEnv() },',
              'env: { ...process.env, LIMEBOT: "1", LIMEBOT_ADMIN_TOKEN: process.env.USRBG_ADMIN_TOKEN },');

fs.writeFileSync(p, s);
console.log("patched ok, len", s.length);

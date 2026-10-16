// Same relay as service-worker.js, for the Firefox MV2 background page.
const SITE_COMMAND_WHITELIST = new Set([
    "TOGGLE_MUTE",
    "TOGGLE_DEAFEN",
    "TOGGLE_VOICE_MODE",
    "TOGGLE_STREAMER_MODE",
    "TOGGLE_GO_LIVE_STREAMING",
    "NAVIGATE_BACK",
    "NAVIGATE_FORWARD",
    "SAVE_CLIP",
]);

async function findDiscordTabs() {
    return browser.tabs.query({ url: ["*://*.discord.com/*"] });
}

async function sendCommandToApp(command) {
    const tabs = await findDiscordTabs();
    const results = await Promise.allSettled(
        tabs.map(tab => browser.tabs.sendMessage(tab.id, { command }))
    );
    return results.filter(r => r.status === "fulfilled").length;
}

browser.runtime.onMessage.addListener(message => {
    if (message.type === "limeyV1:site:command") {
        // Returning the promise lets Firefox deliver the response once it
        // resolves — needed so the site gets a real ack.
        return (async () => {
            if (typeof message.command !== "string" || !SITE_COMMAND_WHITELIST.has(message.command)) {
                return { contacted: 0 };
            }
            return { contacted: await sendCommandToApp(message.command) };
        })();
    }

    if (message.action === "openShortcuts") {
        browser.tabs.create({ url: "about://extensions/shortcuts" });
    }
});

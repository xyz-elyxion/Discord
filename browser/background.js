// Same relay as service-worker.js, for the Firefox MV2 background page.
// Dragify cross-platform drag relay is shared in browserRelay.js (loaded
// first via manifestv2 background scripts — a MV2 background page isn't a
// worker, so importScripts doesn't exist here).

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

browser.runtime.onMessage.addListener((message) => {
    if (message.action === "openShortcuts") {
        browser.tabs.create({ url: "about://extensions/shortcuts" });
        return;
    }

    if (message.type === "limeyV1:site:command") {
        // Returning the promise lets Firefox deliver the response once it
        // resolves — needed so the site gets a real ack.
        return (async () => {
            // Bring the app to the front — the one site request that isn't a
            // keybind, just "show me Discord" (mirrors service-worker.js).
            if (message.command === "APP_FOCUS") {
                const tabs = await findDiscordTabs();
                if (tabs[0]) await browser.tabs.update(tabs[0].id, { active: true });
                return { contacted: tabs.length };
            }

            if (typeof message.command !== "string" || !SITE_COMMAND_WHITELIST.has(message.command)) {
                return { contacted: 0 };
            }
            return { contacted: await sendCommandToApp(message.command) };
        })();
    }

    // Dragify cross-platform drag relay: Firefox's promise-based API adapts
    // nicely (resolve to { contacted }) — no sendResponse juggling needed.
    if (message.type === "limeyV1:dragify") {
        return handleDragifyFromPage(message).catch(() => ({ contacted: 0 }));
    }
});

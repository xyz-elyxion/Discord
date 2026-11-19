// Same relay as service-worker.js, for the Firefox MV2 background page.
// Dragify cross-platform drag relay is shared in browserRelay.js (loaded
// first via manifestv2 background scripts — a MV2 background page isn't a
// worker, so importScripts doesn't exist here).

browser.runtime.onMessage.addListener((message) => {
    if (message.action === "openShortcuts") {
        browser.tabs.create({ url: "about://extensions/shortcuts" });
        return;
    }

    // Dragify cross-platform drag relay: Firefox's promise-based API adapts
    // nicely (resolve to { contacted }) — no sendResponse juggling needed.
    if (message.type === "limeyV1:dragify") {
        return handleDragifyFromPage(message).catch(() => ({ contacted: 0 }));
    }
});

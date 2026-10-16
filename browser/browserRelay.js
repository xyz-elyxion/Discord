/*
 * Limey V1 — Dragify cross-platform drag relay (extension background).
 *
 * Bridging two message loops:
 *   app -> site  ("send"): the app pins an entity chip to every Limey site
 *                  tab (and darkens its dock with the resulting tab count).
 *   site -> app  ("open"): a pinned chip's "Open in app" click is delivered
 *                  into any open discord.com tab; entity payloads distinguish
 *                  themselves from the site's ping command vocabulary.
 * Both sides ack so freshness never guesses: defaults are dropped when a 
 * delivered tab actually responds.
 */

const DRAGIFY_META_WHITELIST = new Set(["open", "send", "opened", "delivered"]);

// Helper, duplicated from the MODULE-STYLE parts of the codebase for safety.
function findTabsByPattern(patterns) {
    if (typeof browser !== "undefined" && browser.tabs) {
        return browser.tabs.query({ url: patterns });
    }
    return chrome.tabs.query({ url: patterns });
}

function sendToTabs(tabs, payload) {
    const senders = tabs.map(async tab => {
        try {
            await (typeof browser !== "undefined" && browser.tabs
                ? browser.tabs.sendMessage(tab.id, payload)
                : chrome.tabs.sendMessage(tab.id, payload));
            return true;
        } catch (err) {
            // Tab may be navigated away, suspended or closed — not an error we surface.
            return false;
        }
    });
    return Promise.all(senders).then(results => results.filter(Boolean).length);
}

async function handleDragifyFromPage(message) {
    const action = message?.action;
    if (typeof action !== "string" || !DRAGIFY_META_WHITELIST.has(action)) {
        return { contacted: 0 };
    }

    if (action === "open") {
        // site -> app: ping the app's discord.com tabs.
        const discordPatterns = ["*://*.discord.com/*"];
        const tabs = await findTabsByPattern(discordPatterns);
        const contacted = await sendToTabs(tabs, {
            type: "limeyV1:dragify",
            action: "open",
            entity: message.entity
        });
        return { contacted };
    }

    // Translate into the site page's incoming vocabulary: app-initiated pins
    // arrive as "limeyV1:dragify:incoming" with action "send"; open/drop
    // acknowledgements arrive as "limeyV1:dragify:ack" so a chip can flash.
    const sitePatterns = [
        "https://limey-discord.onrender.com/*",
        "http://localhost/*"
    ];
    const tabs = await findTabsByPattern(sitePatterns);
    const leaf = action === "send"
        ? { type: "limeyV1:dragify:incoming", action: "send", entity: message.entity }
        : { type: "limeyV1:dragify:ack", action, entity: message.entity, seq: message.seq };
    const contacted = await sendToTabs(tabs, leaf);
    return { contacted };
}

// Both Chrome MV3 and Firefox MV2 use this shape — the caller wires the listener.
// Returns true while an async response is pending so the channel stays open.
function handleRuntimeMessage(message, sendResponse) {
    if (!message || typeof message !== "object") return false;

    if (message.type === "limeyV1:dragify") {
        handleDragifyFromPage(message)
            .then(result => sendResponse(result))
            .catch(() => sendResponse({ contacted: 0 }));
        return true;
    }
    return false;
}

// Commands the Limey site remote may trigger in the app — same ids as the
// manifest's `commands`, i.e. Discord's global keybind actions the renderer
// can already perform. Anything else a page sends is dropped.
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

const DISCORD_TAB_QUERY = { url: ["*://*.discord.com/*"] };

async function findDiscordTabs() {
    return chrome.tabs.query(DISCORD_TAB_QUERY);
}

// Fire a keybind command into every open discord.com tab. Resolves with how
// many tabs accepted it, so the site can show a real ack instead of guessing.
async function sendCommandToApp(command) {
    const tabs = await findDiscordTabs();
    const results = await Promise.allSettled(
        tabs.map(tab => chrome.tabs.sendMessage(tab.id, { command }))
    );
    return results.filter(r => r.status === "fulfilled").length;
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { command });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openShortcuts") {
    chrome.tabs.create({ url: "about://extensions/shortcuts" });
    return false;
  }

  if (message.type === "limeyV1:site:command") {
    (async () => {
      // Bring the app to the front — the one site request that isn't a
      // keybind, just "show me Discord".
      if (message.command === "APP_FOCUS") {
        const tabs = await findDiscordTabs();
        if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
        sendResponse({ contacted: tabs.length });
        return;
      }

      // Only relay commands the app actually understands (the keybind set).
      if (typeof message.command !== "string" || !SITE_COMMAND_WHITELIST.has(message.command)) {
        sendResponse({ contacted: 0 });
        return;
      }

      sendResponse({ contacted: await sendCommandToApp(message.command) });
    })();
    return true; // keep the message channel open for the async sendResponse
  }
});

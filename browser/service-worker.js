importScripts("browserRelay.js");

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { command });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openShortcuts") {
    chrome.tabs.create({ url: "about://extensions/shortcuts" });
    return false;
  }

  // Dragify cross-platform drag relay (site <-> app via this background).
  if (handleRuntimeMessage(message, sendResponse)) return true;
});

// Limey V1 extension popup logic: status check + quick links.

const $ = id => document.getElementById(id);

$("version").textContent = `Limey V1 v${chrome.runtime.getManifest().version}`;

document.querySelectorAll("a[href]").forEach(a => a.addEventListener("click", () => window.close()));

$("shortcutsBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openShortcuts" });
    window.close();
});

// Show whether the current tab is a Discord tab the extension supports
// (i.e. the mod bundle is running there). Content scripts on discord.com
// answer the shared keybind "ping" channel; anything else reports no.
async function checkStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:\/\/([\w-]+\.)?discord\.com\//.test(tab.url)) {
        $("statusText").textContent = "Not a Discord tab";
        $("statusDetail").textContent = "Open discord.com to use the mod";
        $("dot").classList.add("bad");
        return;
    }

    try {
        const res = await chrome.tabs.sendMessage(tab.id, { command: "APP_FOCUS" }).then(
            () => true,
            () => false
        );
        $("statusText").textContent = res ? "Active in this tab" : "Enabled — reload the tab if nothing shows";
        $("statusDetail").textContent = tab.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (res) $("dot").classList.add("ok");
    } catch {
        $("statusText").textContent = "Enabled (extension active browser-wide)";
        $("statusDetail").textContent = tab.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
}

checkStatus();

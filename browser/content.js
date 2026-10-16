if (typeof browser === "undefined") {
    var browser = chrome;
}

// The site relays only make sense on Limey's own pages; everything else
// (meta handshake + keybind forwarding) is the existing discord.com plumbing.
const isLimeySite = /(^|\.)limey-discord\.onrender\.com$/.test(location.hostname) || location.hostname === "localhost";

document.addEventListener(
    "DOMContentLoaded",
    () => {
        window.postMessage({
            type: "limeyV1:meta",
            meta: {
                EXTENSION_VERSION: browser.runtime.getManifest().version,
                EXTENSION_BASE_URL: browser.runtime.getURL(""),
                RENDERER_CSS_URL: browser.runtime.getURL("dist/Limey V1.css"),
            }
        });

        browser.runtime.onMessage.addListener(request => {
            window.postMessage({
                type: "limeyV1:keybinds",
                meta: request.command
            });
        });

        window.addEventListener('message', function(event) {
            if (event.source !== window) return;
            const data = event.data;

            if (data && data.type === 'OPEN_SHORTCUTS') {
                browser.runtime.sendMessage({ action: "openShortcuts" });
                return;
            }

            // Limey site remote: the website asks the extension to make the
            // app do things. Ping answers here; commands travel through the
            // service worker into any open discord.com tab (which forwards
            // them into Limey's keybind actions).
            if (isLimeySite && data && data.type === "limeyV1:site") {
                if (data.action === "ping") {
                    window.postMessage({
                        type: "limeyV1:site:pong",
                        version: browser.runtime.getManifest().version
                    });
                    return;
                }

                if (data.action === "command" && typeof data.command === "string") {
                    browser.runtime.sendMessage(
                        { type: "limeyV1:site:command", command: data.command },
                        response => {
                            window.postMessage({
                                type: "limeyV1:site:ack",
                                command: data.command,
                                contacted: response ? response.contacted : 0
                            });
                        }
                    );
                }
            }
        }, false);
    },
    { once: true }
);

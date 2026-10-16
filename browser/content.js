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
            // Finished dragify leaves (already in page vocabulary) go straight
            // through: pins to the site, open/insert acks to both sides.
            if (request && (request.type === "limeyV1:dragify:incoming" || request.type === "limeyV1:dragify:ack")) {
                window.postMessage(request);
                return;
            }

            // Dragify cross-platform relay broadcasts from the extension
            // background: action "open" (and site->app payloads) surface in the
            // app, "opened"/"delivered"/"send" acks surface on the site.
            if (request && request.type === "limeyV1:dragify") {
                if (request.action === "open") {
                    window.postMessage({
                        type: "limeyV1:dragify:incoming",
                        action: "open",
                        entity: request.entity
                    });
                } else {
                    window.postMessage({
                        type: "limeyV1:dragify:ack",
                        action: request.action,
                        contacted: request.contacted ?? 0,
                        seq: request.seq
                    });
                }
                return;
            }

            if (request?.command) {
                window.postMessage({
                    type: "limeyV1:keybinds",
                    meta: request.command
                });
            }
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

            // Dragify inter-platform bridge (works in BOTH directions' hosts:
            // on the site page it forwards page-initiated actions into the
            // extension; on discord.com tabs it forwards the app's outgoing
            // pins and acks. `viaExtension` marks background-relayed leaves so
            // they don't loop back into the runtime channel).
            if (data && data.type === "limeyV1:dragify" && !data.viaExtension) {
                if ((data.action === "open") && isLimeySite) {
                    browser.runtime.sendMessage({
                        type: "limeyV1:dragify",
                        action: "open",
                        entity: data.entity
                    });
                    return;
                }

                if (data.action === "send") {
                    browser.runtime.sendMessage(
                        { type: "limeyV1:dragify", action: "send", entity: data.entity, seq: data.seq },
                        response => {
                            window.postMessage({
                                type: "limeyV1:dragify:ack",
                                action: "send",
                                seq: data.seq,
                                contacted: response ? response.contacted : 0
                            });
                        }
                    );
                    return;
                }

                if (data.action === "opened" || data.action === "delivered") {
                    browser.runtime.sendMessage({
                        type: "limeyV1:dragify",
                        action: data.action,
                        entity: data.entity
                    });
                }
            }
        }, false);
    },
    { once: true }
);

/*
 * Limey site Dragify — drag Discord things from your app onto any Limey V1
 * page (and back).
 *
 * Two complementary paths:
 *   1. Native drags: the app's Dragify plugin puts a Discord entity on the
 *      system dataTransfer ("application/dragify" + a canonical
 *      discord.com link), so dropping it on a Limey page works like any
 *      file/link drop — no extension required for the drop itself.
 *   2. Extension relay: the pinned chips "Open in app" via the site's remote
 *      bridge, and the app can push "Send to the Limey site" chips here even
 *      without a drag (see public/limey-remote.js + the extension relay).
 *
 * Chips are themselves native drag sources, so pin -> drag into your Discord
 * completes the round trip.
 */
(function () {
    "use strict";

    const DOCK_ID = "limey-dragify-dock";
    const OVERLAY_ID = "limey-dragify-overlay";
    const MAX_CHIPS = 12;

    const CHANNEL_URL_RE = /discord(?:app)?\.com\/channels\/(\d{17,20}|@me)\/(\d{17,20})(?:\/(\d{17,20}))?/;
    const USER_URL_RE = /discord(?:app)?\.com\/users\/(\d{17,20})/;

    let chips = [];

    // ------------------------------------------------------------------ dock

    function ensureDock() {
        let dock = document.getElementById(DOCK_ID);
        if (dock) return dock;
        dock = document.createElement("div");
        dock.id = DOCK_ID;
        dock.setAttribute("role", "list");
        dock.setAttribute("aria-label", "Pinned from your Discord app");
        dock.innerHTML =
            '<div class="limey-dragify-dock-head">' +
            '  <span class="limey-dragify-dock-title">🍋 Pinned from Discord</span>' +
            '  <span class="limey-dragify-dock-hint">drag a chip back into your app</span>' +
            "</div>" +
            '<div class="limey-dragify-chips"></div>';
        document.body.appendChild(dock);
        return dock;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        }[c]));
    }

    function entityUrl(entity) {
        if (entity.url) return entity.url;
        if (entity.kind === "message") {
            return `https://discord.com/channels/${entity.guildId || "@me"}/${entity.channelId}/${entity.id}`;
        }
        if (entity.kind === "channel") {
            return `https://discord.com/channels/${entity.guildId || "@me"}/${entity.id}`;
        }
        if (entity.kind === "user") {
            return `https://discord.com/users/${entity.id}`;
        }
        return null;
    }

    function chipTitle(entity) {
        if (entity.name) return entity.name;
        switch (entity.kind) {
            case "user": return "Discord user";
            case "message": return "Discord message";
            case "plugin": return entity.id ? `${entity.id} plugin` : "Limey plugin";
            case "guild": return "Discord server";
            case "channel": return `#${entity.id}`;
            default: return "Discord item";
        }
    }

    function chipSubtitle(entity) {
        if (entity.subtitle) return entity.subtitle;
        switch (entity.kind) {
            case "user": return `@${entity.id}`;
            case "message": return "Message";
            case "plugin": return "Limey V1 plugin";
            case "guild": return `Server · ${entity.id}`;
            case "channel": return "Channel";
            default: return "";
        }
    }

    function makeChip(entity) {
        const dock = ensureDock();
        const key = `${entity.kind}:${entity.id}:`;
        if (chips.some(c => c.dataset.dragifyKey === key)) {
            const existing = chips.find(c => c.dataset.dragifyKey === key);
            flashChip(existing, "already pinned");
            return;
        }

        const chip = document.createElement("div");
        chip.className = "limey-chip limey-chip-" + (entity.kind || "entity");
        chip.dataset.dragifyKey = key;
        chip.setAttribute("role", "listitem");
        chip.draggable = true;

        let iconContent = entity.iconText || "#";
        let iconHtml;
        if (entity.iconUrl) {
            iconHtml = `<img class="limey-chip-icon" src="${escapeHtml(entity.iconUrl)}" alt="" loading="lazy">`;
        } else {
            iconHtml = `<span class="limey-chip-icon limey-chip-icon-text">${escapeHtml(entity.iconText || (entity.kind === "user" ? "@" : entity.kind === "plugin" ? "🍋" : "#"))}</span>`;
        }

        const url = entityUrl(entity);
        const openable = entity.kind === "channel" || entity.kind === "message" || entity.kind === "guild" || entity.kind === "plugin" || entity.kind === "user";
        const copyLink = url ? `<button class="limey-chip-btn limey-chip-copy" title="Copy link" type="button">🔗</button>` : "";
        const openBtn = openable ? `<button class="limey-chip-btn limey-chip-open" title="Open in your Discord app" type="button">Open in app</button>` : "";
        chip.innerHTML =
            `${iconHtml}` +
            '<div class="limey-chip-body">' +
            `  <span class="limey-chip-title">${escapeHtml(chipTitle(entity))}</span>` +
            `  <span class="limey-chip-sub">${escapeHtml(chipSubtitle(entity))}</span>` +
            "</div>" +
            openBtn +
            copyLink +
            '<button class="limey-chip-btn limey-chip-x" title="Unpin" type="button">✕</button>';

        chip.addEventListener("dragstart", event => {
            // Mark the payload as site-origin so the app can flash "opened in
            // app ✓ / inserted ✓" back onto this chip afterwards.
            const payload = JSON.stringify({ ...entity, origin: "limey-site" });
            event.dataTransfer.setData("application/dragify", payload);
            const link = url || (entity.kind === "plugin" ? entity.url : "");
            event.dataTransfer.setData("text/uri-list", link || "");
            event.dataTransfer.setData("text/plain", link || entity.id || "");
            event.dataTransfer.effectAllowed = "copy";
        });

        chip.querySelector(".limey-chip-x").addEventListener("click", () => {
            chips = chips.filter(c => c !== chip);
            chip.remove();
            if (!chips.length) dock.classList.remove("is-visible");
        });

        if (url) {
            chip.querySelector(".limey-chip-copy")?.addEventListener("click", () => {
                navigator.clipboard?.writeText(url).then(
                    () => flashChip(chip, "copied ✓"),
                    () => { }
                );
            });
        }

        chip.querySelector(".limey-chip-open")?.addEventListener("click", () => {
            openInApp(entity, chip);
        });

        (dock.querySelector(".limey-dragify-chips")).appendChild(chip);
        chips.push(chip);
        dock.classList.add("is-visible");
        flashChip(chip, "pinned ✓");
    }

    function flashChip(chip, text) {
        if (!chip) return;
        const body = chip.querySelector(".limey-chip-body");
        if (!body) return;
        const before = body.querySelector(".limey-chip-flash");
        if (before) before.remove();
        const flash = document.createElement("span");
        flash.className = "limey-chip-flash";
        flash.textContent = text;
        body.appendChild(flash);
        setTimeout(() => flash.remove(), 1600);
    }

    // ---------------------------------------------------- "open in app" path

    let openTimeout = null;

    function openInApp(entity, chip) {
        const button = chip.querySelector(".limey-chip-open");
        if (button) button.disabled = true;

        window.postMessage({
            type: "limeyV1:dragify:page",
            action: "open",
            entity: { kind: entity.kind, id: entity.id, guildId: entity.guildId, channelId: entity.channelId, url: entity.url }
        }, "*");

        clearTimeout(openTimeout);
        openTimeout = setTimeout(() => {
            if (button) {
                button.disabled = false;
                flashChip(chip, "no app found");
            }
        }, 4000);
    }

    window.addEventListener("message", event => {
        const data = event.data;
        if (!data || typeof data !== "object") return;

        // Extension-relayed acks from the app for our outgoing actions:
        // "open in app" clicks and site->chat drops.
        if (data.type === "limeyV1:dragify:ack" && (data.action === "opened" || data.action === "delivered")) {
            const entity = data.entity || {};
            const key = `${entity.kind}:${entity.id}:`;
            const chip = chips.find(c => c.dataset.dragifyKey === key);
            if (chip) {
                const button = chip.querySelector(".limey-chip-open");
                if (button) button.disabled = false;
                clearTimeout(openTimeout);
                flashChip(chip, data.action === "opened" ? "opened in app ✓" : "inserted in chat ✓");
            }
        }

        if (data.type === "limeyV1:dragify:ack" && data.action === "delivered" && data.entity) {
            const key = `${data.entity?.kind}:${data.entity?.id}:`;
            const chip = chips.find(c => c.dataset.dragifyKey === key);
            if (chip) flashChip(chip, "inserted in chat ✓");
        }
    });

    // ------------------------------------------------------------- drop path

    function ensureOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (overlay) return overlay;
        overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        overlay.setAttribute("aria-hidden", "true");
        overlay.innerHTML =
            '<div class="limey-dragify-overlay-frame">' +
            "  <div class='limey-dragify-overlay-emoji'>🍋</div>" +
            "  <div class='limey-dragify-overlay-title'>Drop onto Limey V1</div>" +
            "  <div class='limey-dragify-overlay-sub'>channels, messages, users and servers</div>" +
            "</div>";
        document.body.appendChild(overlay);
        return overlay;
    }

    function looksDragify(event) {
        const types = event.dataTransfer?.types;
        if (!types) return false;
        for (const t of types) if (t === "application/dragify") return true;
        return false;
    }

    function parseDragifyJson(raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.id && parsed.kind) return parsed;
            if (parsed && parsed.kind === "plugin" && parsed.url) return parsed;
        } catch { /* not ours */ }
        return null;
    }

    function parseDrop(dataTransfer, done) {
        const entity = parseDragifyJson(dataTransfer.getData("application/dragify"));
        if (entity) return done([entity]);

        // Drags whose richer payload we can't read (different browser
        // session) still carry canonical links as the text fallback. Every
        // recognisable link in the transfer becomes its own chip.
        const text = `${dataTransfer.getData("text/uri-list")}\n${dataTransfer.getData("text/plain")}`;
        const entities = [];
        for (const line of text.split(/\s+/)) {
            const chan = CHANNEL_URL_RE.exec(line);
            if (chan) {
                entities.push({
                    kind: chan[3] ? "message" : "channel",
                    id: chan[3] || chan[2],
                    channelId: chan[2],
                    guildId: chan[1] === "@me" ? "@me" : chan[1],
                });
                continue;
            }
            const usr = USER_URL_RE.exec(line);
            if (usr) {
                entities.push({ kind: "user", id: usr[1] });
                continue;
            }
            // Plugin links from a rendered plugin-card drag (text fallback
            // path): limey-discord.onrender.com/plugins#PluginName
            const pluginMatch = /^(?:https?:\/\/)[^#]*\/plugins\/?#(.+)$/.exec(line);
            if (pluginMatch) {
                const name = decodeURIComponent(pluginMatch[1].split("&")[0]);
                if (name) {
                    entities.push({
                        kind: "plugin",
                        id: name,
                        name,
                        url: `https://limey-discord.onrender.com/plugins#${encodeURIComponent(name)}`,
                    });
                }
            }
        }
        done(entities);
    }

    let dragDepth = 0;

    window.addEventListener("dragenter", event => {
        if (!looksDragify(event)) return;
        dragDepth += 1;
        ensureOverlay().classList.add("is-visible");
    });

    window.addEventListener("dragover", event => {
        if (!looksDragify(event)) return;
        event.preventDefault(); // required for the drop event to fire
    });

    window.addEventListener("dragleave", event => {
        if (!looksDragify(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.getElementById(OVERLAY_ID)?.classList.remove("is-visible");
    });

    window.addEventListener("drop", event => {
        document.getElementById(OVERLAY_ID)?.classList.remove("is-visible");
        dragDepth = 0;
        if (!looksDragify(event)) return;
        event.preventDefault();
        event.stopPropagation();
        parseDrop(event.dataTransfer, list => {
            for (const entity of list) makeChip(entity);
        });
    });

    // ------------------------------------------------ plugin card drag source

    // Plugin list cards on /plugins get a drag payload: dragging one into a
    // Discord chat (or pinning it) shares the plugin page link. The cards are
    // rendered by the page's own script, so re-wire on grid mutations too.
    function markPluginCards() {
        let attempts = 0;
        const source = () => document.querySelector("#grid, #communityGrid");
        const tryStart = () => {
            attempts += 1;
            const grid = source();
            if (!grid) {
                if (attempts < 10) setTimeout(tryStart, 800);
                return;
            }
        const wireCards = () => {
            grid.querySelectorAll(".plugin-card:not([data-limey-dragify])").forEach(card => {
                card.dataset.limeyDragify = "plugin";
                card.draggable = true;
                const name = card.querySelector("h3")?.textContent?.trim();
                if (!name) return;
                const url = `https://limey-discord.onrender.com/plugins#${encodeURIComponent(name)}`;
                card.addEventListener("dragstart", event => {
                    const payload = JSON.stringify({ kind: "plugin", id: name, name, url });
                    event.dataTransfer.setData("application/dragify", payload);
                    event.dataTransfer.setData("text/uri-list", url);
                    event.dataTransfer.setData("text/plain", url);
                    event.dataTransfer.effectAllowed = "copy";
                });
            });
        };
        wireCards();
        new MutationObserver(wireCards).observe(grid, { childList: true });
    }
        tryStart();
    }
    markPluginCards();
})();

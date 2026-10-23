/*
 * Limey V1 Ghost Client — ESP canvas renderer.
 *
 * The main process snaps this window exactly over the Discord client and
 * forwards every relay state snapshot here. We draw each effect anchor at
 * its measured position inside the Discord viewport (1:1 thanks to the
 * zoom factor mirroring), so the crown floats right next to the owner's
 * name in the member list — like game ESP, and screenshare-proof because
 * this window belongs to the EXE, not to Discord.
 */
"use strict";

const { ipcRenderer } = require("electron");

const esp = document.getElementById("esp");
const badge = document.getElementById("esp-badge");

let lastState = null;
let badgeFade = null;

function draw() {
    let html = "";
    let anchors = 0;
    if (lastState && lastState.paired !== false) {
        for (const a of lastState.anchors || []) {
            if (a.effect === "crown") {
                anchors++;
                // The anchor marker is zero-width; its center line is the
                // username line of the owner's row.
                const top = a.y + (a.h || 16) / 2;
                html += `<div class="esp-anchor esp-crown" style="left:${a.x}px;top:${top}px;">👑</div>`;
            }
        }
    }
    esp.innerHTML = html;

    // Keep the badge as long as we are waiting; hide it once something is
    // actually drawn (and never re-show it while spikes keep arriving).
    if (anchors) {
        badge.textContent = `🎯 ESP — ${anchors} anchor${anchors === 1 ? "" : "s"} locked`;
        badge.classList.remove("dim");
        clearTimeout(badgeFade);
        badgeFade = setTimeout(() => { badge.style.opacity = "0"; }, 4000);
    } else {
        badge.style.opacity = "";
        clearTimeout(badgeFade);
        const waiting = !lastState || lastState.paired === false
            ? "🎯 ESP — waiting for Limey V1 in Discord…"
            : "🎯 ESP — no anchors yet: open a server's member list with the owner visible";
        badge.textContent = waiting;
        badge.classList.add("dim");
    }
}

ipcRenderer.on("esp-state", (_event, state) => {
    lastState = state;
    draw();
});

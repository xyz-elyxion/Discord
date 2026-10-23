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

let lastState = null;

function draw() {
    let html = "";
    if (lastState && lastState.paired !== false) {
        for (const a of lastState.anchors || []) {
            if (a.effect === "crown") {
                // The anchor marker is zero-width; its center line is the
                // username line of the owner's row.
                const top = a.y + (a.h || 16) / 2;
                html += `<div class="esp-anchor esp-crown" style="left:${a.x}px;top:${top}px;">👑</div>`;
            }
        }
    }
    esp.innerHTML = html;
}

ipcRenderer.on("esp-state", (_event, state) => {
    lastState = state;
    draw();
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 iFlex0x and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Ported from github.com/iFlex0x/actualFullScreen (GPL-3.0-or-later), which
 * ships as a Vencord userplugin. The behaviour is unchanged: Discord keeps the
 * voice-participants panel open over a fullscreen stream, so collapse it while
 * the layout is fullscreen and put the user's previous choice back when the
 * layout leaves fullscreen or the call ends.
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ChannelRTCStore, FluxDispatcher, SelectedChannelStore } from "@webpack/common";

/** Per-channel "was the participants panel open before we hid it" latch. */
const openBefore = new Map<string, boolean>();

function setOpen(channelId: string, open: boolean) {
    FluxDispatcher.dispatch({
        type: "CHANNEL_RTC_UPDATE_PARTICIPANTS_OPEN",
        channelId,
        participantsOpen: open
    });
}

function hide(channelId: string) {
    if (openBefore.has(channelId)) return;

    const wasOpen = ChannelRTCStore.getParticipantsOpen(channelId);
    openBefore.set(channelId, wasOpen);
    if (wasOpen) setOpen(channelId, false);
}

function restore(channelId: string) {
    if (!openBefore.has(channelId)) return;

    const wasOpen = openBefore.get(channelId)!;
    openBefore.delete(channelId);

    if (wasOpen && !ChannelRTCStore.getParticipantsOpen(channelId)) setOpen(channelId, true);
}

export default definePlugin({
    name: "ActualFullScreen",
    description: "Hides the voice members panel while a stream is fullscreen, so fullscreen is actually fullscreen.",
    tags: ["Voice", "Appearance"],
    authors: [Devs.iFlex0x],
    permissions: [
        {
            id: "uiPatches",
            title: "Change Discord's voice call UI",
            description: "Collapses and restores the voice participants panel while a stream is fullscreen.",
            risk: "Only the participant-panel toggle is touched, and the previous state is restored when the stream ends; a bug could still leave the panel in the wrong state until the plugin is disabled."
        }
    ],

    start() {
        // A client that is already watching a fullscreen stream when the plugin
        // is enabled would otherwise stay covered until the next layout change.
        const channelId = SelectedChannelStore.getVoiceChannelId();
        if (channelId && ChannelRTCStore.getLayout(channelId, "APP") === "full-screen") hide(channelId);
    },

    stop() {
        for (const channelId of [...openBefore.keys()]) restore(channelId);
    },

    flux: {
        CALL_DELETE({ channelId }: { channelId: string; }) {
            restore(channelId);
        },

        CHANNEL_RTC_UPDATE_LAYOUT({ channelId, layout, appContext }: {
            channelId: string;
            layout: string;
            appContext?: string;
        }) {
            if (appContext && appContext !== "APP") return;

            if (layout === "full-screen") hide(channelId);
            else restore(channelId);
        }
    }
});

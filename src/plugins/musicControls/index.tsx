/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

import { settings, toggleHoverControls } from "./settings";
import { migrateOldLyrics } from "./spotify/lyrics/api";
import { SpotifyLyrics } from "./spotify/lyrics/components/lyrics";
import { SpotifyPlayer } from "./spotify/PlayerComponent";
import { TidalLyrics } from "./tidal/lyrics/components/lyrics";
import { stopTidalLrcStore } from "./tidal/lyrics/providers/store";
import { TidalPlayer } from "./tidal/TidalPlayer";
import { stopTidalStore } from "./tidal/TidalStore";

export default definePlugin({
    name: "MusicControls",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        },
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Keeps plugin data (settings, caches, history) in the client's local DataStore.",
            risk: "Data persists on your device between sessions; deleted content may be retained here."
        },
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Talks to the configured music service (Spotify, Tidal, etc.) to control playback and fetch track/lyric info.",
            risk: "Requests are made with your session; destinations see your IP address."
        },
        {
            id: "sendNotifications",
            title: "Show notifications",
            description: "Can show a notification when the playing track changes.",
            risk: "Frequent notifications could be used to distract or social-engineer you."
        }
    ],
    description: "Music Controls and Lyrics for multiple services ",
    authors: [Devs.Ven, Devs.afn, Devs.KraXen72, Devs.Av32000, Devs.nin0dev, Devs.thororen, Devs.vmohammad, Devs.Joona],
    settings,
    tags: ["Media", "Activity"],
    searchTerms: [
        // Spotify
        "Spotify",
        "SpotifyControls",
        "SpotifyLyrics",
        // Tidal
        "Tidal",
        "TidalControls",
        "TidalLyrics",
    ],

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                // react.jsx)(AccountPanel, { ..., showTaglessAccountPanel: blah })
                match: /(?<=\i\.jsxs?\)\()(\i),{(?=[^}]*?userTag:\i,occluded:)/,
                // react.jsx(WrapperComponent, { VencordOriginal: AccountPanel, ...
                replace: "$self.PanelWrapper,{VencordOriginal:$1,"
            },
        },
        {
            find: ".PLAYER_DEVICES",
            replacement: [{
                // Adds POST and a Marker to the SpotifyAPI (so we can easily find it)
                match: /get:(\i)\.bind\(null,(\i\.\i)\.get\)/,
                replace: "post:$1.bind(null,$2.post),vcSpotifyMarker:1,$&"
            },
            {
                // Spotify Connect API returns status 202 instead of 204 when skipping tracks.
                // Discord rejects 202 which causes the request to send twice. This patch prevents this.
                match: /202===\i\.status/,
                replace: "false",
            }]
        },
        {
            find: 'repeat:"off"!==',
            replacement: [
                {
                    // Discord doesn't give you shuffle state and the repeat kind, only a boolean
                    match: /repeat:"off"!==(\i),/,
                    replace: "shuffle:arguments[2]?.shuffle_state??false,actual_repeat:$1,$&"
                },
                {
                    match: /(?<=artists.filter\(\i=>).{0,10}\i\.id\)&&/,
                    replace: ""
                }
            ]
        },
    ],

    PanelWrapper({ VencordOriginal, ...props }) {
        const { showTidalControls, showTidalLyrics, showSpotifyLyrics, showSpotifyControls, lyricsPosition } = settings.store;
        return (
            <>
                <ErrorBoundary
                    fallback={() => (
                        <div className="vc-tidal-fallback">
                            <p>Failed to render Modal :(</p>
                            <p>Check the console for errors</p>
                        </div>
                    )}
                >
                    {showTidalLyrics && lyricsPosition === "above" && <TidalLyrics />}
                    {showTidalControls && <TidalPlayer />}
                    {showTidalLyrics && lyricsPosition === "below" && <TidalLyrics />}
                    {showSpotifyLyrics && lyricsPosition === "above" && <SpotifyLyrics />}
                    {showSpotifyControls && <SpotifyPlayer />}
                    {showSpotifyLyrics && lyricsPosition === "below" && <SpotifyLyrics />}
                </ErrorBoundary>

                <VencordOriginal {...props} />
            </>
        );
    },

    async start() {
        await migrateOldLyrics();
        toggleHoverControls(settings.store.hoverControls);
    },

    stop() {
        stopTidalLrcStore();
        stopTidalStore();
    },
});

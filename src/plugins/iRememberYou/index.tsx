/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addMessagePreSendListener, removeMessagePreSendListener } from "@api/MessageEvents";
import { EyeIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { Devs } from "@utils/constants";
import { removeFromArray } from "@utils/misc";
import definePlugin from "@utils/types";

import { Data } from "./components/data";
import DataUI from "./components/ui";

export default definePlugin({
    name: "IRememberYou",
    permissions: [
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Keeps a private on-device record of users and servers you encounter, so notifications and profiles can show it.",
            risk: "Builds a history of who you've met; stays on your device but could be sensitive."
        },
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Sees message authors and channel/server info from Discord events to record who you communicate with (not the message text).",
            risk: "Metadata about your conversations could be inferred if abused."
        }
    ],
    description: "Locally saves everyone you've been communicating with (including servers), in case of lose",
    tags: ["Chat", "Servers"],
    authors: [Devs.zoodogood, Devs.keircn, Devs.tt],
    dependencies: ["MessageEventsAPI"],

    patches: [],

    async start() {
        SettingsPlugin.customEntries.push({
            key: "equicord_i_remember_you",
            title: "I Remember You",
            Component: () => <DataUI usersCollection={data.usersCollection} />,
            Icon: EyeIcon
        });

        const data = (this.dataManager = await new Data().withStart());

        await data.initializeUsersCollection();
        data.writeGuildsOwnersToCollection();
        data.writeMembersFromUserGuildsToCollection();
        data._onMessagePreSend_preSend = addMessagePreSendListener(
            data.onMessagePreSend.bind(data)
        );
        data.storageAutoSaveProtocol();
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "equicord_i_remember_you");

        const dataManager = this.dataManager as Data;
        removeMessagePreSendListener(dataManager._onMessagePreSend_preSend);
        clearInterval(dataManager._storageAutoSaveProtocol_interval);
    },
});

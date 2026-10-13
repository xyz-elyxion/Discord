/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { UserIcon } from "@components/Icons";
import { definePluginSettings } from "@api/Settings";
import SettingsPlugin from "@plugins/_core/settings";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { removeFromArray } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { SettingsRouter } from "@webpack/common";

import ProfileSetsTab from "./components/profileSetsTab";
import { loadPresets } from "./utils/storage";

export const cl = classNameFactory("lime-profile-presets-");
export const settings = definePluginSettings({
    avatarSize: {
        type: OptionType.SLIDER,
        description: "Avatar size in preset list.",
        markers: [56, 64, 72, 80, 88, 96],
        default: 56,
        stickToMarkers: true
    },
});

export default definePlugin({
    name: "ProfileSets",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Allows you to save and load different profile presets.",
    tags: ["Appearance", "Customisation", "Utility"],
    authors: [Devs.omaw, Devs.justjxke],
    settings,
    toolboxActions: {
        "Open Profile Sets": () => {
            SettingsRouter.openUserSettings("limey_profile_sets_panel");
        },
    },

    start() {
        loadPresets("main");
        SettingsPlugin.customEntries.push({
            key: "limey_profile_sets",
            title: "Profile Sets",
            Component: ProfileSetsTab,
            Icon: UserIcon
        });
    },

    stop() {
        removeFromArray(SettingsPlugin.customEntries, e => e.key === "limey_profile_sets");
    },
});

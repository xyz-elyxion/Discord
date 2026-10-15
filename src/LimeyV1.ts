/*!
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// DO NOT REMOVE UNLESS YOU WISH TO FACE THE WRATH OF THE CIRCULAR DEPENDENCY DEMON!!!!!!!
import "~plugins";
import "./fixWeirdAppRegionBug.css";

import nativeTitleBarStyles from "./nativeTitleBar.css?managed";

export * as Api from "./api";
export * as Plugins from "./api/PluginManager";
export * as Components from "./components";
export * as Util from "./utils";
export * as Updater from "./utils/updater";
export * as Webpack from "./webpack";
export * as WebpackPatcher from "./webpack/patchWebpack";
export { PlainSettings, Settings };

import { enableStyle, initStyles } from "@api/Styles";
import { ChangelogTab, openSettingsTabModal } from "@components/settings";
import { debounce } from "@shared/debounce";
import { StartAt } from "@utils/types";
import { SettingsRouter } from "@webpack/common";

import { get as dsGet } from "./api/DataStore";
import { NotificationData, showNotification } from "./api/Notifications";
import { initPluginManager, plugins as Plugins, PMLogger, startAllPlugins, stopPlugin } from "./api/PluginManager";
import { PlainSettings, Settings, SettingsStore } from "./api/Settings";
import { areLocalSettingsDirty, getCloudSettings, getCloudSyncDirection, markLocalSettingsDirty, putCloudSettings, shouldCloudSync } from "./api/SettingsSync/cloudSync";
import { checkCurrentBan, installBannedNotice } from "./utils/banSwitch";
import { installLimeyOffNotice,isLimeyDisabled } from "./utils/limeySwitch";
import { relaunch } from "./utils/native";
import { checkForUpdates, update, UpdateLogger } from "./utils/updater";
import { onceReady } from "./webpack";
import { patches } from "./webpack/patchWebpack";

if (IS_REPORTER) {
    require("./debug/runReporter");
}

async function syncSettings() {
    // pre-check for local shared settings
    if (
        Settings.cloud.authenticated &&
        !await dsGet("LimeyV1_cloudSecret") // this has been enabled due to local settings share or some other bug
    ) {
        // show a notification letting them know and tell them how to fix it
        showNotification({
            title: "Cloud Integrations",
            body: "We've noticed you have cloud integrations enabled in another client! Due to limitations, you will " +
                "need to re-authenticate to continue using them. Click here to go to the settings page to do so!",
            color: "var(--yellow-360)",
            onClick: () => SettingsRouter.openUserSettings("limeyV1_cloud_panel"),
            noPersist: true
        });
        return;
    }

    if (
        Settings.cloud.settingsSync && // if it's enabled
        Settings.cloud.authenticated && // if cloud integrations are enabled
        getCloudSyncDirection() !== "manual" // if we're not in manual mode
    ) {
        if (areLocalSettingsDirty() && shouldCloudSync("push")) {
            await putCloudSettings();
        } else if (shouldCloudSync("pull") && await getCloudSettings(false)) { // if we synchronized something (false means no sync)
            // we show a notification here instead of allowing getCloudSettings() to show one to declutter the amount of
            // potential notifications that might occur. getCloudSettings() will always send a notification regardless if
            // there was an error to notify the user, but besides that we only want to show one notification instead of all
            // of the possible ones it has (such as when your settings are newer).
            showNotification({
                title: "Cloud Settings",
                body: "Your settings have been updated! Click here to restart to fully apply changes!",
                color: "var(--green-360)",
                onClick: relaunch
            });
        }
    }

    const saveSettingsOnFrequentAction = debounce(async () => {
        if (Settings.cloud.settingsSync && Settings.cloud.authenticated && shouldCloudSync("push")) {
            await putCloudSettings();
        }
    }, 60_000);

    SettingsStore.addGlobalChangeListener(() => {
        markLocalSettingsDirty();
        saveSettingsOnFrequentAction();
    });
}

let notifiedForUpdatesThisSession = false;

async function runUpdateCheck() {
    if (IS_UPDATER_DISABLED) return;

    const notify = (data: NotificationData) => {
        if (notifiedForUpdatesThisSession) return;
        notifiedForUpdatesThisSession = true;

        setTimeout(() => showNotification({
            permanent: true,
            noPersist: true,
            ...data
        }), 10_000);
    };

    try {
        const isOutdated = await checkForUpdates();
        if (!isOutdated) return;

        if (Settings.autoUpdate) {
            await update();
            if (Settings.autoUpdateNotification) {
                notify({
                    title: "Limey V1 has been updated!",
                    body: "Click here to see what changed",
                    onClick: () => openSettingsTabModal(ChangelogTab!)
                });
            }
            return;
        }

        notify({
            title: "A Limey V1 update is available!",
            body: "Click here to view the changelog",
            onClick: () => openSettingsTabModal(ChangelogTab!)
        });
    } catch (err) {
        UpdateLogger.error("Failed to check for updates", err);
    }
}

// Ban gate: after webpack sessions are live, ask the Limey V1 backend whether
// the current user is banned from the mod. Banned boots fold everything down
// (limeySwitch-style) instead of starting plugins.
const banGate = onceReady.then(() => checkCurrentBan());

async function init() {
    await onceReady;
    const ban = await banGate;
    if (ban?.banned) {
        // Stop anything already running (StartAt.Init plugins) and start no
        // more. Registered webpack patches can't be rewound live — that's an
        // inherent limit of renderer-side enforcement.
        for (const name in Plugins) {
            const p = Plugins[name];
            if (p.started) stopPlugin(p);
        }
        installBannedNotice(ban);
        return;
    }

    startAllPlugins(StartAt.WebpackReady);

    syncSettings();

    if (!IS_WEB && !IS_UPDATER_DISABLED) {
        runUpdateCheck();

        // this tends to get really annoying, so only do this if the user has auto-update without notification enabled
        if (Settings.autoUpdate && !Settings.autoUpdateNotification) {
            setInterval(runUpdateCheck, 1000 * 60 * 30); // 30 minutes
        }
    }

    if (IS_DEV) {
        const pendingPatches = patches.filter(p => !p.all && p.predicate?.() !== false);
        if (pendingPatches.length)
            PMLogger.warn(
                "Webpack has finished initialising, but some patches haven't been applied yet.",
                "This might be expected since some Modules are lazy loaded, but please verify",
                "that all plugins are working as intended.",
                "You are seeing this warning because this is a Development build of LimeyV1.",
                "\nThe following patches have not been applied:",
                "\n\n" + pendingPatches.map(p => `${p.plugin}: ${p.find}`).join("\n")
            );
    }
}

if (isLimeyDisabled()) {
    // Turned off (e.g. via Recovery Mode): keep the boot inert — no plugins,
    // no patches registered, no styles — and show the small corner notice
    // with the "Turn back on" button instead.
    installLimeyOffNotice();
} else {
    initPluginManager();
    initStyles();
    startAllPlugins(StartAt.Init);
    init();

    document.addEventListener("DOMContentLoaded", () => {
        void banGate.then(ban => {
            if (ban?.banned) {
                installBannedNotice(ban);
                return;
            }
            startAllPlugins(StartAt.DOMContentLoaded);

            if (IS_DISCORD_DESKTOP && Settings.nativeTitleBar) {
                enableStyle(nativeTitleBarStyles);
            }
        });
    }, { once: true });
}

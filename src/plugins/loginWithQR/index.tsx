/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { getIntlMessage } from "@utils/discord";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Button, Forms, Menu } from "@webpack/common";
import { ReactElement } from "react";

import { preload, unload } from "./images";
import { cl } from "./ui";
import openQrModal from "./ui/modals/QrModal";

export default definePlugin({
    name: "LoginWithQR",
    permissions: [
        {
            id: "uiPatches",
            title: "Patch Discord's UI and internals",
            description: "Modifies Discord's components, styles or internal stores to change behaviour or appearance.",
            risk: "Patches run inside your client with full plugin privileges; bugs can break the client until disabled."
        }
    ],
    description: "Allows you to login to another device by scanning a login QR code, just like on mobile!",
    authors: [Devs.Nexpid],

    settings: definePluginSettings({
        scanQr: {
            type: OptionType.COMPONENT,
            description: "Scan a QR code",
            component() {
                if (!LimeyV1.Plugins.plugins.LoginWithQR.started)
                    return (
                        <Forms.FormText>
                            Enable the plugin and restart your client to scan a login QR code
                        </Forms.FormText>
                    );

                return (
                    <Button size={Button.Sizes.SMALL} onClick={openQrModal}>
                        {getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")}
                    </Button>
                );
            },
        },
    }),

    patches: [
        // NOTE: The old approach patched `handleGlobalPaste:(\i)` in Discord's
        // paste-handler module, but Discord now destructures that key inside its
        // module factory, so injecting an arrow function there produced
        // "SyntaxError: Invalid destructuring assignment target" while eval'ing
        // the patched module. The paste-block is instead implemented (patch-free)
        // by the capture-phase paste listener below.
        // Insert a Scan QR Code button in the My Account tab
        {
            find: "UserSettingsAccountProfileCard",
            replacement: {
                // Find the Edit User Profile button and insert our custom button.
                // A bit jank, but whatever
                match: /,(\(.{1,90}#{intl::USER_SETTINGS_EDIT_USER_PROFILE}\)}\))/,
                replace: ",$self.insertScanQrButton($1)",
            },
        },
        // Insert a Scan QR Code MenuItem in the Swith Accounts popout
        {
            find: 'id:"manage-accounts"',
            replacement: {
                match: /(id:"manage-accounts",.*?)}\)\)(,\i)/,
                replace: "$1}),$self.ScanQrMenuItem)$2"
            }
        },

        // Insert a Scan QR Code button in the Settings sheet
        {
            find: "useGenerateUserSettingsSections",
            replacement: {
                match: /\.CONNECTIONS/,
                replace: "$&,\"SCAN_QR_CODE\""
            }
        },
        // Insert a Scan QR Code button in the Settings sheet (part 2)
        {
            find: ".PRIVACY_ENCRYPTION_VERIFIED_DEVICES_V2]",
            replacement: {
                match: /\.CLIPS]:{.*?},/,
                replace: "$&\"SCAN_QR_CODE\":$self.ScanQrSettingsSheet,"
            }
        }
    ],

    qrModalOpen: false,

    onPaste(e: ClipboardEvent) {
        // Prevent paste from also hitting Discord's global paste handler while
        // the QR modal is open (so users can paste a login uri without side effects)
        if (this.qrModalOpen) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    },

    insertScanQrButton: (button: ReactElement) => (
        <div className={cl("settings-btns")}>
            <Button size={Button.Sizes.SMALL} onClick={openQrModal}>
                {getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")}
            </Button>
            {button}
        </div>
    ),
    get ScanQrMenuItem() {
        return <Menu.MenuItem id="scan-qr" label={getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")} action={openQrModal} />;
    },
    get ScanQrSettingsSheet() {
        return {
            section: getIntlMessage("USER_SETTINGS_SCAN_QR_CODE"),
            onClick: openQrModal,
            searchableTitles: [getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")],
            label: getIntlMessage("USER_SETTINGS_SCAN_QR_CODE"),
            ariaLabel: getIntlMessage("USER_SETTINGS_SCAN_QR_CODE")
        };
    },

    start() {
        // Preload images
        preload();

        document.addEventListener("paste", this.onPaste, true);
    },

    stop() {
        document.removeEventListener("paste", this.onPaste, true);
        unload?.();
    },
});

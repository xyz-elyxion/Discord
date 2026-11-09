/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { JSX } from "react";

import { getQuestifySettings, useQuestifySettings } from "../settings/access";
import { Alerts } from "../utils/ui";
import { type ManaSelectOption, SettingsCard, SettingsDescription, SettingsHeader, SettingsSelect, SettingsSubheader, SettingsSubtleSwitch } from "./shared";

type QuestDisableSettingKey =
    | "disableAccountPanelPromo"
    | "disableAccountPanelQuestProgress"
    | "disableFriendsListPromo"
    | "disableMembersListPromo"
    | "disableOrbsAndQuestsBadges"
    | "disableRelocationNotices"
    | "disableSponsoredBanner";

interface QuestDisableOption {
    key: QuestDisableSettingKey;
    label: string;
}

const disableFeatureOptions = [
    {
        key: "disableSponsoredBanner",
        label: "Sponsored Banner",
    },
    {
        key: "disableRelocationNotices",
        label: "Relocation Notices",
    },
    {
        key: "disableFriendsListPromo",
        label: "Friends List Promo",
    },
    {
        key: "disableMembersListPromo",
        label: "Members List Promo",
    },
    {
        key: "disableAccountPanelPromo",
        label: "Account Panel Promo",
    },
    {
        key: "disableAccountPanelQuestProgress",
        label: "Account Panel Progress",
    },
    {
        key: "disableOrbsAndQuestsBadges",
        label: "Quest & Orbs Badges",
    },
] as const satisfies readonly QuestDisableOption[];

const disableManaOptions: ManaSelectOption[] = disableFeatureOptions.map(({ key, label }) => ({
    id: key,
    label,
    value: key,
}));

export function QuestFeaturesSetting(): JSX.Element {
    const questFeatures = useQuestifySettings([
        "disableQuestsEverything",
        "disableSponsoredBanner",
        "disableRelocationNotices",
        "disableFriendsListPromo",
        "disableMembersListPromo",
        "disableAccountPanelPromo",
        "disableAccountPanelQuestProgress",
        "disableOrbsAndQuestsBadges",
    ]);

    const selectedDisableValues = disableFeatureOptions
        .filter(({ key }) => questFeatures[key])
        .map(({ key }) => key);

    function updateDisableValue(value: string | string[] | null) {
        const selectedKeys = new Set(Array.isArray(value) ? value : value ? [value] : []);

        for (const { key } of disableFeatureOptions) {
            getQuestifySettings()[key] = selectedKeys.has(key);
        }
    }

    function confirmDangerousSettingChange(body: string, onConfirm: () => void) {
        Alerts.show({
            title: "Are you sure?",
            body,
            confirmText: "Continue",
            confirmVariant: "critical-primary",
            cancelText: "Cancel",
            onConfirm,
        });
    }

    function updateDisableEverything(checked: boolean) {
        function setDisableEverything() {
            getQuestifySettings().disableQuestsEverything = checked;
        }

        if (checked) {
            confirmDangerousSettingChange(
                "This will completely disable Quest functionality.",
                setDisableEverything
            );
        } else {
            setDisableEverything();
        }
    }

    return (
        <SettingsCard>
            <SettingsHeader> Quest Features </SettingsHeader>
            <SettingsDescription> Modify how Quests behave to enhance or remove functionality. </SettingsDescription>
            <SettingsSubheader> Disable Features </SettingsSubheader>
            <SettingsSubtleSwitch
                checked={questFeatures.disableQuestsEverything}
                label="Completely disable Quest functionality:"
                onChange={updateDisableEverything}
                bottomSpacing="10"
                tooltip={{
                    position: "top",
                    text: "This will disable all plugin enhancements, hide the Quests page and Quest elements across Discord, and prevent Discord from fetching Quest data. This will not affect the shop as Orbs are too intrinsically tied to it as a secondary currency."
                }}
            />
            <SettingsSelect
                label="Disable specific features:"
                wrapTags={true}
                options={disableManaOptions}
                value={selectedDisableValues}
                closeOnSelect={false}
                maxOptionsVisible={7}
                selectionMode="multiple"
                disabled={questFeatures.disableQuestsEverything}
                onSelectionChange={updateDisableValue}
                tooltip={{
                    position: "top",
                    text: "Sponsored Banner is a paid-for Quest banner at the top of the Quests page."
                        + "\n\nRelocation Notices are indicators such as in the Discovery page about Quests moving to DMs."
                        + "\n\nFriends List Promo is a card that displays on the \"Active Now\" section of your Friends List while a user you share a server with is playing a game with an active Quest."
                        + "\n\nMembers List Promo is an icon that displays on members in a server's Members List while they are playing a game with an active Quest."
                        + "\n\nAccount Panel Promo is a paid-for Quest promotion that appears above your user account panel."
                        + "\n\nAccount Panel Progress is the active or completed Quest progress shown above your user account panel."
                        + "\n\nQuest & Orbs Badges are badges on user profiles for when someone has completed at least one Quest or bought the Orbs badge respectively."
                }}
            />
        </SettingsCard>
    );
}

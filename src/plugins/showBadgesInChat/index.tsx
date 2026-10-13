/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import badges from "@plugins/_api/badges";
import { Devs } from "@utils/constants";
import { isPluginDev } from "@utils/misc";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy, findCssClassesLazy } from "@webpack";

const { roleIcon } = findCssClassesLazy("roleIcon", "separator");
const RoleIconComponent = findComponentByCodeLazy("#{intl::ROLE_ICON_ALT_TEXT}");

import { User } from "@limeyV1/discord-types";
import { JSX } from "react";

import settings from "./settings";

const discordBadges: readonly [number, string, string][] = Object.freeze([
    [0, "Discord Staff", "5e74e9b61934fc1f67c65515d1f7e60d"],
    [1, "Partnered Server Owner", "3f9748e53446a137a052f3454e2de41e"],
    [2, "HypeSquad Events", "bf01d1073931f921909045f3a39fd264"],
    [6, "HypeSquad Bravery", "8a88d63823d8a71cd5e390baa45efa02"],
    [7, "HypeSquad Brilliance", "011940fd013da3f7fb926e4a1cd2e618"],
    [8, "HypeSquad Balance", "3aa41de486fa12454c3761e8e223442e"],
    [3, "Discord Bug Hunter", "2717692c7dca7289b35297368a940dd0"],
    [14, "Discord Bug Hunter", "848f79194d4be5ff5f81505cbd0ce1e6"],
    [17, "Early Verified Bot Developer", "6df5892e0f35b051f8b61eace34f4967"],
    [9, "Early Supporter", "7060786766c9c840eb3019e725d2b358"],
    [18, "Moderator Programs Alumni", "fee1624003e2fee35cb398e125dc479b"]
]);

// Same lime icon the BadgeAPI uses for the Limey V1 Contributor profile badge
const LIMEY_CONTRIBUTOR_BADGE =
    "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2064%2064'%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'32'%20r%3D'30'%20fill%3D'%231f2d16'%2F%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'34'%20r%3D'21'%20fill%3D'%237cb518'%2F%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'34'%20r%3D'17'%20fill%3D'%23c9ef8f'%2F%3E%0A%3Cg%20stroke%3D'%237cb518'%20stroke-width%3D'3'%20stroke-linecap%3D'round'%3E%0A%3Cpath%20d%3D'M32%2034L32%2019'%2F%3E%3Cpath%20d%3D'M32%2034L44.2%2026.5'%2F%3E%3Cpath%20d%3D'M32%2034L44.2%2041.5'%2F%3E%0A%3Cpath%20d%3D'M32%2034L32%2049'%2F%3E%3Cpath%20d%3D'M32%2034L19.8%2041.5'%2F%3E%0A%3Cpath%20d%3D'M32%2034L19.8%2026.5'%2F%3E%0A%3C%2Fg%3E%0A%3Cpath%20d%3D'M32%208c4%203%206%206%206%209-4%200-8-2-9-5%200-2%201-4%203-4z'%20fill%3D'%233f6212'%2F%3E%0A%3Ccircle%20cx%3D'24'%20cy%3D'22'%20r%3D'3'%20fill%3D'%23ffffff'%20opacity%3D'.35'%2F%3E%0A%3C%2Fsvg%3E";

function CheckBadge({ badge, author }: { badge: string; author: User; }): JSX.Element | null {

    switch (badge) {
        case "LimeyDonor":
            return (
                <span style={{ order: settings.store.LimeyDonorPosition }}>
                    {badges.getDonorBadges(author.id)?.map(badge => (
                        <RoleIconComponent
                            key={author.id}
                            className={roleIcon}
                            name={badge.description}
                            size={20}
                            src={badge.iconSrc}
                        />
                    ))}
                </span>
            );
        case "LimeyContributor":
            return isPluginDev(author.id) ? (
                <span style={{ order: settings.store.LimeyContributorPosition }}>
                    <RoleIconComponent
                        className={roleIcon}
                        name="Limey V1 Contributor"
                        size={20}
                        src={LIMEY_CONTRIBUTOR_BADGE}
                    />
                </span>
            ) : null;
        case "DiscordProfile":
            const chatBadges = discordBadges
                .filter(badge => (author.flags || author.publicFlags) & (1 << badge[0]))
                .map(badge => (

                    <RoleIconComponent
                        key={author.id}
                        className={roleIcon}
                        name={badge[1]}
                        size={20}
                        src={`https://cdn.discordapp.com/badge-icons/${badge[2]}.png`}
                    />
                ));
            return chatBadges.length > 0 ? (
                <span style={{ order: settings.store.DiscordProfilePosition }}>
                    {chatBadges}
                </span>
            ) : null;
        case "DiscordNitro":
            return (author?.premiumType ?? 0) > 0 ? (
                <span style={{ order: settings.store.DiscordNitroPosition }}>
                    <RoleIconComponent
                        className={roleIcon}
                        name={
                            "Discord Nitro" +
                            (author.premiumType === 3 ? " Basic" : author.premiumType === 1 ? " Classic" : "")
                        }
                        size={20}
                        src={"https://cdn.discordapp.com/badge-icons/2ba85e8026a8614b640c2837bcdfe21b.png"}
                    />
                </span>
            ) : null;
        default:
            return null;
    }
}

function ChatBadges({ author }: { author: User; }) {

    return (
        <span className="lime-sbic-badge-row" style={{ margin: "2px" }}>
            {settings.store.showLimeyDonor && <CheckBadge badge={"LimeyDonor"} author={author} />}
            {settings.store.showLimeyContributor && <CheckBadge badge={"LimeyContributor"} author={author} />}
            {settings.store.showDiscordProfile && <CheckBadge badge={"DiscordProfile"} author={author} />}
            {settings.store.showDiscordNitro && <CheckBadge badge={"DiscordNitro"} author={author} />}
        </span>
    );
}

export default definePlugin({
    name: "ShowBadgesInChat",
    authors: [Devs.Inbestigator, Devs.KrystalSkull],
    description: "Shows the message author's badges beside their name in chat.",
    dependencies: ["MessageDecorationsAPI"],
    tags: ["Appearance", "Chat"],
    settings,
    renderMessageDecoration(props) {
        return props.message?.author ? <ChatBadges author={props.message.author} /> : null;
    }
});

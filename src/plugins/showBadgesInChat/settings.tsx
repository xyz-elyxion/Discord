/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { OptionType } from "@utils/types";
import { useEffect, UserStore, useState } from "@webpack/common";

const settings = definePluginSettings({
    showLimeyDonor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Limey V1 Donor badges in chat.",
        hidden: true,
        default: true
    },
    LimeyDonorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Limey V1 Donor badges.",
        hidden: true,
        default: 0
    },
    showLimeyContributor: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Limey V1 Contributor badges in chat.",
        hidden: true,
        default: true
    },
    LimeyContributorPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Limey V1 Contributor badge.",
        hidden: true,
        default: 1
    },
    showDiscordProfile: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Discord profile badges in chat.",
        hidden: true,
        default: true
    },
    DiscordProfilePosition: {
        type: OptionType.NUMBER,
        description: "The position of the Discord profile badges.",
        hidden: true,
        default: 6
    },
    showDiscordNitro: {
        type: OptionType.BOOLEAN,
        description: "Enable to show Discord Nitro badges in chat.",
        hidden: true,
        default: true
    },
    DiscordNitroPosition: {
        type: OptionType.NUMBER,
        description: "The position of the Discord Nitro badge.",
        hidden: true,
        default: 7
    },
    badgeSettings: {
        type: OptionType.COMPONENT,
        description: "Setup badge layout and visibility",
        component: () => <BadgeSettings />
    }
});

export default settings;

const LIMEY_CONTRIBUTOR_BADGE =
    "data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20viewBox%3D'0%200%2064%2064'%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'32'%20r%3D'30'%20fill%3D'%231f2d16'%2F%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'34'%20r%3D'21'%20fill%3D'%237cb518'%2F%3E%0A%3Ccircle%20cx%3D'32'%20cy%3D'34'%20r%3D'17'%20fill%3D'%23c9ef8f'%2F%3E%0A%3Cg%20stroke%3D'%237cb518'%20stroke-width%3D'3'%20stroke-linecap%3D'round'%3E%0A%3Cpath%20d%3D'M32%2034L32%2019'%2F%3E%3Cpath%20d%3D'M32%2034L44.2%2026.5'%2F%3E%3Cpath%20d%3D'M32%2034L44.2%2041.5'%2F%3E%0A%3Cpath%20d%3D'M32%2034L32%2049'%2F%3E%3Cpath%20d%3D'M32%2034L19.8%2041.5'%2F%3E%3Cpath%20d%3D'M32%2034L19.8%2026.5'%2F%3E%0A%3C%2Fg%3E%0A%3Cpath%20d%3D'M32%208c4%203%206%206%206%209-4%200-8-2-9-5%200-2%201-4%203-4z'%20fill%3D'%233f6212'%2F%3E%0A%3Ccircle%20cx%3D'24'%20cy%3D'22'%20r%3D'3'%20fill%3D'%23ffffff'%20opacity%3D'.35'%2F%3E%0A%3C%2Fsvg%3E";

const BadgeSettings = () => {
    const [images, setImages] = useState([
        { src: "https://cdn.discordapp.com/emojis/1026533070955872337.png", shown: settings.store.showLimeyDonor, title: "Limey V1 donor badges", key: "LimeyDonor", position: settings.store.LimeyDonorPosition },
        { src: LIMEY_CONTRIBUTOR_BADGE, shown: settings.store.showLimeyContributor, title: "Limey V1 contributor badge", key: "LimeyContributor", position: settings.store.LimeyContributorPosition },
        { src: "https://cdn.discordapp.com/badge-icons/bf01d1073931f921909045f3a39fd264.png", shown: settings.store.showDiscordProfile, title: "Discord profile badges (HypeSquad, Discord Staff, Early Supporter, etc.)", key: "DiscordProfile", position: settings.store.DiscordProfilePosition },
        { src: "https://cdn.discordapp.com/badge-icons/2ba85e8026a8614b640c2837bcdfe21b.png", shown: settings.store.showDiscordNitro, title: "Nitro badge", key: "DiscordNitro", position: settings.store.DiscordNitroPosition }
    ]);

    useEffect(() => {
        images.forEach(image => {
            switch (image.key) {
                case "LimeyDonor":
                    settings.store.LimeyDonorPosition = image.position;
                    settings.store.showLimeyDonor = image.shown;
                    break;
                case "LimeyContributor":
                    settings.store.LimeyContributorPosition = image.position;
                    settings.store.showLimeyContributor = image.shown;
                    break;
                case "DiscordProfile":
                    settings.store.DiscordProfilePosition = image.position;
                    settings.store.showDiscordProfile = image.shown;
                    break;
                case "DiscordNitro":
                    settings.store.DiscordNitroPosition = image.position;
                    settings.store.showDiscordNitro = image.shown;
                    break;
                default:
                    break;
            }
        });
    }, [images]);

    const handleDragStart = (e: any, index: number) => {
        if (!images[index].shown) {
            e.preventDefault();
        } else {
            e.dataTransfer.setData("index", index);
        }
    };

    const handleDragOver = (e: any) => {
        e.preventDefault();
    };

    const handleDrop = (e: any, dropIndex: number) => {
        const dragIndex = e.dataTransfer.getData("index");
        const newImages = [...images];
        const draggedImage = newImages[dragIndex];

        newImages.splice(dragIndex, 1);
        newImages.splice(dropIndex, 0, draggedImage);

        newImages.forEach((image, index) => {
            image.position = index;
        });

        setImages(newImages);
    };

    const toggleDisable = (index: number) => {
        const newImages = [...images];
        newImages[index].shown = !newImages[index].shown;
        setImages(newImages);
    };

    return (
        <>
            <BaseText>Drag the badges to reorder them, you can click to enable/disable a specific badge type.</BaseText>
            <div className="lime-sbic-badge-settings">
                <img className="lime-sbic-settings-avatar" src={UserStore.getCurrentUser().getAvatarURL()}></img>
                <BaseText className="lime-sbic-settings-username">{(UserStore.getCurrentUser() as any).globalName}</BaseText>
                {images
                    .sort((a, b) => a.position - b.position)
                    .map((image, index) => (
                        <div
                            key={image.key}
                            className={`lime-sbic-image-container ${!image.shown ? "lime-sbic-disabled" : ""}`}
                            onDragOver={e => handleDragOver(e)}
                            onDrop={e => handleDrop(e, index)}
                            onClick={() => toggleDisable(index)}
                        >
                            <img
                                src={image.src}
                                draggable={image.shown}
                                onDragStart={e => handleDragStart(e, index)}
                                title={image.title}
                            />
                        </div>
                    ))
                }
            </div>
        </>
    );
};

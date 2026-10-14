/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { FireIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import definePlugin from "@utils/types";
import { Message } from "@limeyV1/discord-types";
import { ChannelStore, moment, Tooltip, UserStore } from "@webpack/common";

import { settings } from "./settings";
import { useStreaksStore } from "./stores/StreaksStore";

const cl = classNameFactory("vc-streaks-");

const STREAK_THRESHOLDS = {
    ELITE: 100,
    DIAMOND: 60,
    PLATINUM: 45,
    GOLD: 30,
    SILVER: 14,
    BRONZE: 7
};

const colorFor = (streak: number) => {
    if (streak >= STREAK_THRESHOLDS.ELITE) return settings.store.eliteColor;
    if (streak >= STREAK_THRESHOLDS.DIAMOND) return settings.store.diamondColor;
    if (streak >= STREAK_THRESHOLDS.PLATINUM) return settings.store.platinumColor;
    if (streak >= STREAK_THRESHOLDS.GOLD) return settings.store.goldColor;
    if (streak >= STREAK_THRESHOLDS.SILVER) return settings.store.silverColor;
    if (streak >= STREAK_THRESHOLDS.BRONZE) return settings.store.bronzeColor;
    return settings.store.defaultColor;
};

const StreakBadge = ({ userId }: { userId: string; }) => {
    const streaks = useStreaksStore(state => state.streaks);
    const streak = streaks[userId];

    if (!streak || streak.count < 1) return null;

    const today = moment().format("YYYY-MM-DD");
    const active = streak.last_streak_date === today;
    const color = active ? colorFor(streak.count) : "#9ca3af";

    return (
        <Tooltip text={`${streak.count} day streak`}>
            {tooltipProps => (
                <span {...tooltipProps} className={cl("badge")} style={{ color }}>
                    {<FireIcon width={16} height={16} fill={color} />}
                    <span className={cl("count")}>{streak.count}</span>
                </span>
            )}
        </Tooltip>
    );
};

export default definePlugin({
    name: "Streaks",
    permissions: [
        {
            id: "localDataStore",
            title: "Store data locally",
            description: "Keeps your DM streak counts in the client's local DataStore — no account or login involved.",
            risk: "Data persists on your device between sessions; deleted content may be retained here."
        },
        {
            id: "readMessages",
            title: "Read message contents",
            description: "Sees message authors and channel info from Discord events to detect DM activity (message text is not read).",
            risk: "Metadata about who you DM could be inferred if abused."
        }
    ],
    description: "Shows a streak next to a user when you exchange DMs with them on consecutive days. Streaks are tracked locally on your device — no account or login needed.",
    authors: [Devs.Moowi, Devs.thororen],
    tags: ["Friends", "Fun"],
    dependencies: ["MessageDecorationsAPI", "MemberListDecoratorsAPI"],
    settings,

    flux: {
        async CONNECTION_OPEN() {
            await useStreaksStore.getState().load();
        },
        async MESSAGE_CREATE({ optimistic, type, message, channelId }: { optimistic: boolean; type: string; message: Message; channelId: string; }) {
            if (optimistic || type !== "MESSAGE_CREATE" || message.state === "SENDING") return;
            if (message.author?.bot) return;

            const channel = ChannelStore.getChannel(channelId);
            if (!channel.isDM()) return;

            const recipientId = channel.recipients[0];
            if (!recipientId) return;

            const me = UserStore.getCurrentUser()?.id;
            if (message.author.id === me) {
                await useStreaksStore.getState().mark(recipientId, "me");
            } else if (message.author.id === recipientId) {
                await useStreaksStore.getState().mark(recipientId, "them");
            }
        },
    },

    renderMessageDecoration({ message }) {
        const userId = message?.author?.id;
        if (!userId || userId === UserStore.getCurrentUser()?.id) return null;
        return <StreakBadge userId={userId} />;
    },

    renderMemberListDecorator({ user, type }: { type: "guild" | "dm"; user: { id: string; }; }) {
        if (type !== "dm" || !user || user.id === UserStore.getCurrentUser()?.id) return null;
        return <StreakBadge userId={user.id} />;
    },
});

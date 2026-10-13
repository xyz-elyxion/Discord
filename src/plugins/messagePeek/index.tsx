/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { isPluginEnabled } from "@api/PluginManager";
import { ImageIcon, Microphone } from "@components/Icons";
import showMeYourName from "@plugins/showMeYourName";
import { Devs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Activity, ApplicationStream, Channel, Message, OnlineStatus, User } from "@limeyV1/discord-types";
import { MessageFlags } from "@limeyV1/discord-types/enums";
import { findByCodeLazy, findByPropsLazy, findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { ChannelStore, ExperimentStore, MessageStore, Parser, RelationshipStore, SnowflakeUtils, UserGuildSettingsStore, UserStore, useStateFromStores } from "@webpack/common";

// Limey V1 port notes:
// - upstream integrates the Equicord-only plugin `betterActivities`; Limey V1
//   does not have it, so that integration (activity icons next to the preview)
//   is omitted entirely.
// - AttachmentIcon/GifIcon/StickerIcon/VideoIcon do not exist in Limey's
//   @components/Icons; they are inlined below with upstream's exact SVG paths.
// - upstream calls showMeYourName.getTypingMemberListProfilesReactionsVoiceNameText,
//   which this repo's showMeYourName does not (yet) implement; the call is
//   optional-chained so it safely falls back to the nickname/default name.

const cl = classNameFactory("vc-message-peek-");

const PrivateChannelClasses = findCssClassesLazy("subtext", "channel", "interactive");
const ActivityClasses = findCssClassesLazy("textWithIconContainer", "icon", "truncated", "container", "textXs");
const MessageActions = findByPropsLazy("fetchMessages", "sendMessage");

const hasRelevantActivity: (props: ActivityCheckProps) => boolean = findByCodeLazy(".OFFLINE||", ".INVISIBLE)return!1");
const ActivityText: React.ComponentType<ActivityTextProps> = findComponentByCodeLazy('"ActivityStatus"');

const ONE_HOUR_MS = 60 * 60 * 1000;

const settings = definePluginSettings({
    hideMuted: {
        type: OptionType.BOOLEAN,
        description: "Hide message previews and timestamps for muted DMs and group chats.",
        default: false
    }
});

type AttachmentType = "image" | "gif" | "video" | "file";
type IconType = AttachmentType | "voice" | "sticker";
type PeekingIconProps = { size?: string; className?: string; };

function sizeToPx(size?: string) {
    switch (size) {
        case "xxs": return 12;
        case "xs": return 16;
        case "sm": return 20;
        default: return 24;
    }
}

function LimeyImageIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return <ImageIcon width={px} height={px} className={className} />;
}

function LimeyMicrophoneIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return <Microphone width={px} height={px} className={className} />;
}

function InlineAttachmentIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return (
        <svg width={px} height={px} viewBox="0 0 24 24" className={className} aria-hidden>
            <path fill="currentColor" d="M10.57 4.01a6.97 6.97 0 0 1 9.86 0l.54.55a6.99 6.99 0 0 1 0 9.88l-7.26 7.27a1 1 0 0 1-1.42-1.42l7.27-7.26a4.99 4.99 0 0 0 0-7.06L19 5.43a4.97 4.97 0 0 0-7.02 0l-8.02 8.02a3.24 3.24 0 1 0 4.58 4.58l6.24-6.24a1.12 1.12 0 0 0-1.58-1.58l-3.5 3.5a1 1 0 0 1-1.42-1.42l3.5-3.5a3.12 3.12 0 1 1 4.42 4.42l-6.24 6.24a5.24 5.24 0 0 1-7.42-7.42l8.02-8.02Z" />
        </svg>
    );
}

function InlineGifIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return (
        <svg width={px} height={px} viewBox="0 0 24 24" className={className} aria-hidden>
            <path fill="currentColor" fillRule="evenodd" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3V5a3 3 0 0 0-3-3H5Zm2.18 13.87a2.9 2.9 0 0 1-1.66-.49 3.18 3.18 0 0 1-1.12-1.35A4.88 4.88 0 0 1 4 12c0-.75.14-1.42.42-2 .29-.59.7-1.04 1.24-1.37a3.7 3.7 0 0 1 1.95-.5c.64 0 1.21.14 1.72.4.5.28.89.67 1.15 1.16l-1.22.88a1.76 1.76 0 0 0-1.64-1.02c-.66 0-1.17.22-1.52.65a2.74 2.74 0 0 0-.53 1.8c0 .78.18 1.39.53 1.81.35.42.86.64 1.52.64.3 0 .57-.06.81-.16.25-.12.45-.27.58-.47v-.93H7.3v-1.4h3.24v4.23H9.27l-.2-.71c-.43.57-1.06.86-1.89.86Zm6.34-.15h-1.57V8.28h1.57v7.44Zm1.51 0h1.57v-2.83h2.76v-1.42H16.6V9.7H20V8.28h-4.97v7.44Z" clipRule="evenodd" />
        </svg>
    );
}

function InlineStickerIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return (
        <svg width={px} height={px} viewBox="0 0 24 24" className={className} aria-hidden>
            <path fill="currentColor" fillRule="evenodd" d="M6 2h12a4 4 0 0 1 4 4v7.5a.5.5 0 0 1-.5.5H19a5 5 0 0 0-5 5v2.5a.5.5 0 0 1-.5.5H6a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4Zm.5 8a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM19 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-9.91 2.94a1 1 0 0 0-1.66 1.12 5.5 5.5 0 0 0 9.14 0 1 1 0 0 0-1.66-1.12 3.5 3.5 0 0 1-5.82 0Z" clipRule="evenodd" />
            <path fill="currentColor" d="M21.66 16c.03 0 .05.03.04.06a3 3 0 0 1-.58.82l-4.24 4.24a3 3 0 0 1-.82.58.04.04 0 0 1-.06-.04V19a3 3 0 0 1 3-3h2.66Z" />
        </svg>
    );
}

function InlineVideoIcon({ size, className }: PeekingIconProps) {
    const px = sizeToPx(size);
    return (
        <svg width={px} height={px} viewBox="0 0 24 24" className={className} aria-hidden>
            <path fill="currentColor" d="M4 4a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-2.12a1 1 0 0 0 .55.9l3 1.5a1 1 0 0 0 1.45-.9V7.62a1 1 0 0 0-1.45-.9l-3 1.5a1 1 0 0 0-.55.9V7a3 3 0 0 0-3-3H4Z" />
        </svg>
    );
}

const Icons: Record<IconType, React.ComponentType<PeekingIconProps>> = {
    image: LimeyImageIcon,
    file: InlineAttachmentIcon,
    voice: LimeyMicrophoneIcon,
    sticker: InlineStickerIcon,
    gif: InlineGifIcon,
    video: InlineVideoIcon,
};

const ATTACHMENT_LABELS: Record<AttachmentType, string> = {
    gif: "GIF",
    image: "image",
    video: "video",
    file: "file"
};

// Limey V1 port note: replaces @utils/misc's pluralize helper (present in
// Equicord, absent here) with the same semantics.
function pluralize(amount: number, singular: string, plural = singular + "s") {
    return amount === 1 ? `${amount} ${singular}` : `${amount} ${plural}`;
}

interface ActivityCheckProps {
    activities: Activity[] | null;
    status: OnlineStatus;
    applicationStream: ApplicationStream | null;
    voiceChannel: Channel | null;
}

interface ActivityTextProps {
    user: User;
    activities: Activity[] | null;
    applicationStream: ApplicationStream | null;
    voiceChannel: Channel | null;
}

interface PrivateChannelProps extends ActivityCheckProps {
    channel: Channel;
    user: User;
}

interface MessageContent {
    text: React.ReactNode;
    icon?: IconType;
}

function getAttachmentType(contentType = ""): AttachmentType {
    if (contentType === "image/gif") return "gif";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
    return "file";
}

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days >= 365) return `${Math.floor(days / 365)}y`;
    if (days >= 30) return `${Math.floor(days / 30)}mo`;
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    return `${Math.max(1, minutes)}m`;
}

function getMessageContent(message: Message): MessageContent | null {
    if (message.content) {
        if (/https?:\/\/(\S+\.gif|tenor\.com|giphy\.com|klipy\.com)/i.test(message.content)) {
            return { text: "sent a GIF", icon: "gif" };
        }
        return { text: Parser.parseInlineReply(message.content) };
    }

    if (message.flags & MessageFlags.IS_VOICE_MESSAGE) {
        return { text: "voice message", icon: "voice" };
    }

    if (message.attachments?.length) {
        const types = message.attachments.map(a => getAttachmentType(a.content_type));
        const count = types.length;
        const firstType = types[0];
        const allSameType = types.every(t => t === firstType);

        if (allSameType) {
            return { text: pluralize(count, ATTACHMENT_LABELS[firstType]), icon: firstType };
        }
        return { text: pluralize(count, "file"), icon: "file" };
    }

    if (message.stickerItems?.length) {
        return { text: message.stickerItems[0].name, icon: "sticker" };
    }

    return null;
}

function MessagePreviewContent({ channel, user }: { channel: Channel; user: User | null | undefined; }) {
    const lastMessage = useStateFromStores(
        [MessageStore],
        () => MessageStore.getLastMessage(channel.id) as Message | undefined
    );

    if (channel.isSystemDM()) {
        return <>Official Discord Message</>;
    }

    const smynName = isPluginEnabled(showMeYourName.name) ? (showMeYourName as any).getTypingMemberListProfilesReactionsVoiceNameText?.({ user: user ?? lastMessage?.author, type: "membersList" }) ?? null : null;

    if (!lastMessage) {
        if (channel.isMultiUserDM()) return <>{channel.recipients.length + 1} Members</>;
        return null;
    }

    const content = getMessageContent(lastMessage);
    if (!content) return null;

    const currentUserId = UserStore.getCurrentUser()?.id;
    const isOwnMessage = lastMessage.author.id === currentUserId;
    const authorName = isOwnMessage ? "You" : (smynName || RelationshipStore.getNickname(lastMessage.author.id) || lastMessage.author.globalName || lastMessage.author.username);
    const Icon = content.icon ? Icons[content.icon] : null;

    return (
        <div className={classes(ActivityClasses.container, ActivityClasses.textXs, cl("preview"))}>
            <span className={ActivityClasses.truncated}>{authorName}: {content.text}</span>
            {Icon && (
                <span className={cl("icon")}>
                    <Icon size="xxs" className={ActivityClasses.icon} />
                </span>
            )}
        </div>
    );
}

function SubText({ channel, user, activities, applicationStream, voiceChannel, showActivity }: PrivateChannelProps & { showActivity: boolean; }) {
    if (showActivity) {
        return (
            <ActivityText
                user={user}
                activities={activities}
                voiceChannel={voiceChannel}
                applicationStream={applicationStream}
            />
        );
    }

    return (
        <div className={PrivateChannelClasses.subtext}>
            <MessagePreviewContent channel={channel} user={user} />
        </div>
    );
}

function Timestamp({ channel }: { channel: Channel; }) {
    const lastMessage = useStateFromStores([MessageStore], () => MessageStore.getLastMessage(channel.id) as Message | undefined);

    if (!lastMessage) return null;

    const timestamp = SnowflakeUtils.extractTimestamp(lastMessage.id);
    const isChannelPinned = UserGuildSettingsStore.isMessagesFavorite(channel?.id);
    const isFavoritesEnabled = ExperimentStore.getUserExperimentBucket("2026-01-favorites-server") > 0;
    const className = isFavoritesEnabled || isChannelPinned ? cl("timestamp-favorites") : cl("timestamp");
    return <span className={className}>{formatRelativeTime(timestamp)}</span>;
}

function shouldShowActivity(lastMessage: Message | undefined, hasActivity: boolean): boolean {
    if (!hasActivity) return false;
    if (!lastMessage) return true;

    const messageTimestamp = SnowflakeUtils.extractTimestamp(lastMessage.id);
    return Date.now() - messageTimestamp > ONE_HOUR_MS;
}

export default definePlugin({
    name: "MessagePeek",
    description: "Shows the last message preview and timestamp in the Direct Messages list.",
    dependencies: ["MemberListDecoratorsAPI"],
    tags: ["Appearance", "Chat"],
    authors: [Devs.prism, Devs.justjxke],
    settings,
    patches: [
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /,subText:\i\.isSystemDM\(\).{0,700}:null,(?=name:)/,
                replace: ",subText:$self.getSubText(arguments[0]),"
            }
        }
    ],

    async start() {
        const channels = ChannelStore.getSortedPrivateChannels()
            .slice(0, 25)
            .filter(c => !MessageStore.getLastMessage(c.id));

        for (let i = 0; i < channels.length; i += 5) {
            const batch = channels.slice(i, i + 5);

            await Promise.allSettled(
                batch.map(channel =>
                    MessageActions.fetchMessages({
                        channelId: channel.id,
                        limit: 1
                    })
                )
            );

            if (i + 5 < channels.length) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    },

    renderMemberListDecorator({ channel }: { channel?: Channel; }) {
        if (!channel) return null;
        if (settings.store.hideMuted && UserGuildSettingsStore.isChannelMuted(null!, channel.id)) return null;
        return <Timestamp channel={channel} />;
    },

    getSubText(props: PrivateChannelProps) {
        const { channel, user, activities, status, applicationStream, voiceChannel } = props;

        if (settings.store.hideMuted && UserGuildSettingsStore.isChannelMuted(null!, channel.id)) {
            const hasActivity = hasRelevantActivity({ activities, status, applicationStream, voiceChannel });
            if (hasActivity) {
                return (
                    <ActivityText
                        user={user}
                        activities={activities}
                        voiceChannel={voiceChannel}
                        applicationStream={applicationStream}
                    />
                );
            }
            return null;
        }

        const lastMessage = MessageStore.getLastMessage(channel.id) as Message | undefined;
        const hasActivity = hasRelevantActivity({ activities, status, applicationStream, voiceChannel });
        const showActivity = shouldShowActivity(lastMessage, hasActivity);

        return (
            <SubText
                channel={channel}
                user={user}
                activities={activities}
                status={status}
                applicationStream={applicationStream}
                voiceChannel={voiceChannel}
                showActivity={showActivity}
            />
        );
    }
});

/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Constants, DraftStore, DraftType, RestAPI, showToast, Toasts, UploadAttachmentStore, UploadManager, useState, useStateFromStores } from "@webpack/common";

const logger = new Logger("FakeForward");

const DraftManager = findByPropsLazy("clearDraft", "saveDraft");

const busyChannels = new Set<string>();

const settings = definePluginSettings({
    forwardMode: {
        type: OptionType.SELECT,
        displayName: "Source type",
        description: "Whether the temporary forwarding source is a user's DM or an existing channel.",
        options: [
            { label: "User ID (send through DM)", value: "USER" },
            { label: "Channel ID (group DM or server)", value: "CHANNEL" }
        ],
        default: "USER"
    },
    sourceId: {
        type: OptionType.STRING,
        displayName: "Source ID",
        description: "The user or channel ID to use as the temporary forwarding source.",
        default: "1513317540519219261",
        placeholder: "1513317540519219261",
        isValid: (value: string) => /^\d{17,20}$/.test(value.trim()) || "Enter a valid Discord ID."
    }
});

interface PendingUpload {
    file?: Blob;
    filename?: string;
    item?: Blob | {
        file?: Blob;
        name?: string;
    };
    name?: string;
    removeFromMsgDraft?: () => void;
}

const ForwardIcon: IconComponent = ({ height = 20, width = 20, className }) => (
    <svg
        aria-hidden="true"
        className={className}
        fill="none"
        height={height}
        viewBox="0 0 24 24"
        width={width}
    >
        <path
            d="M13 5 20 12 13 19M20 12H8a4 4 0 0 0-4 4v3"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
        />
    </svg>
);

async function deleteSource(channelId: string, messageId: string) {
    await RestAPI.del({
        url: Constants.Endpoints.MESSAGE(channelId, messageId)
    });
}

async function getOrCreateSourceChannel() {
    const targetId = settings.store.sourceId.trim();

    if (settings.store.forwardMode === "CHANNEL") {
        return targetId;
    }

    const response = await RestAPI.post({
        url: "/users/@me/channels",
        body: { recipient_id: targetId }
    });

    return response.body.id as string;
}

function getUploadFile(upload: PendingUpload) {
    if (upload.file instanceof Blob) return upload.file;

    const item = upload.item;
    if (item instanceof Blob) return item;
    if (item?.file instanceof Blob) return item.file;

    return undefined;
}

function createSourceBody(content: string, uploads: PendingUpload[]) {
    if (!uploads.length) return { content };

    const formData = new FormData();
    const attachments: Array<{ id: number; filename: string; }> = [];

    uploads.forEach((upload, index) => {
        const file = getUploadFile(upload);
        if (!file) return;

        const filename = upload.filename
            ?? upload.name
            ?? (!(upload.item instanceof Blob) ? upload.item?.name : undefined)
            ?? (file instanceof File ? file.name : undefined)
            ?? `file_${index}`;

        attachments.push({ id: index, filename });
        formData.append(`files[${index}]`, file, filename);
    });

    if (!attachments.length) {
        throw new Error("The attached files could not be read.");
    }

    formData.append("payload_json", JSON.stringify({
        ...(content.trim() ? { content } : {}),
        attachments
    }));

    return formData;
}

function clearComposer(channelId: string, uploads: PendingUpload[]) {
    try {
        DraftManager.clearDraft(channelId, DraftType.ChannelMessage);
    } catch (error) {
        logger.error("Forward sent, but the text draft could not be cleared", error);
    }

    for (const upload of uploads) {
        try {
            upload.removeFromMsgDraft?.();
        } catch (error) {
            logger.error("Forward sent, but an attachment could not be removed from the draft", error);
        }
    }

    try {
        UploadManager.clearAll(channelId, DraftType.ChannelMessage);
    } catch (error) {
        logger.error("Forward sent, but the attachment manager could not be cleared", error);
    }
}

async function sendAsForward(destinationChannelId: string, content: string, uploads: PendingUpload[]) {
    let sourceChannelId: string | undefined;
    let sourceMessageId: string | undefined;

    try {
        sourceChannelId = await getOrCreateSourceChannel();

        const source = await RestAPI.post({
            url: Constants.Endpoints.MESSAGES(sourceChannelId),
            body: createSourceBody(content, uploads)
        });

        sourceMessageId = source.body.id as string;

        await RestAPI.post({
            url: Constants.Endpoints.MESSAGES(destinationChannelId),
            body: {
                message_reference: {
                    type: 1,
                    message_id: sourceMessageId,
                    channel_id: sourceChannelId
                }
            }
        });

        clearComposer(destinationChannelId, uploads);

        try {
            await deleteSource(sourceChannelId, sourceMessageId);
        } catch (error) {
            logger.error("Forward sent, but the temporary source could not be deleted", error);
            showToast("Forward sent, but the temporary source message could not be deleted.", Toasts.Type.FAILURE);
        }
    } catch (error) {
        logger.error("Failed to create forward", error);

        if (sourceChannelId && sourceMessageId) {
            try {
                await deleteSource(sourceChannelId, sourceMessageId);
            } catch (deleteError) {
                logger.error("Failed to clean up the temporary source", deleteError);
            }
        }

        showToast("Could not create the forward. Your draft and attachments were kept.", Toasts.Type.FAILURE);
    }
}

const FakeForwardButton: ChatBarButtonFactory = ({ channel: { id: channelId } }) => {
    const draft = useStateFromStores(
        [DraftStore],
        () => DraftStore.getDraft(channelId, DraftType.ChannelMessage) ?? ""
    );
    const uploads = useStateFromStores(
        [UploadAttachmentStore],
        () => (UploadAttachmentStore.getUploads(channelId, DraftType.ChannelMessage) ?? []) as PendingUpload[]
    );
    const [busy, setBusy] = useState(() => busyChannels.has(channelId));

    return (
        <ChatBarButton
            tooltip={busy ? "Creating forward..." : "Fake Forward"}
            onClick={async () => {
                if (busyChannels.has(channelId)) return;

                if (!draft.length && !uploads.length) {
                    showToast("Type something or attach a file first.", Toasts.Type.MESSAGE);
                    return;
                }

                busyChannels.add(channelId);
                setBusy(true);

                try {
                    await sendAsForward(channelId, draft, uploads);
                } finally {
                    busyChannels.delete(channelId);
                    setBusy(false);
                }
            }}
            buttonProps={{
                "aria-disabled": busy,
                style: { opacity: busy ? 0.5 : 1 }
            }}
        >
            <ForwardIcon />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "Fake Forward",
    description: "Send your chatbox text and attachments as a real forwarded message.",
    authors: [Devs.NuzFlameV2, Devs.ItsDenji777],
    settings,

    chatBarButton: {
        icon: ForwardIcon,
        render: FakeForwardButton
    }
});

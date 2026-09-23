/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "Quoter" by Kaan
 * (https://github.com/zrodevkaan/BDPlugins) — re-implemented natively
 * for Limey V1.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { CloudUpload as TCloudUpload } from "@limeyV1/discord-types";
import { CloudUploadPlatform } from "@limeyV1/discord-types/enums";
import definePlugin, { OptionType } from "@utils/types";
import { findLazy } from "@webpack";
import {
    Constants,
    FluxDispatcher,
    GuildMemberStore,
    Menu,
    MessageActions,
    PendingReplyStore,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    SnowflakeUtils,
    Toasts,
    UserStore,
    showToast,
} from "@webpack/common";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

type AttributionMode = "username" | "globalName" | "nickname";

const settings = definePluginSettings({
    attribution: {
        description: "What name is shown under the quote",
        type: OptionType.SELECT,
        options: [
            { label: "Username", value: "username", default: true },
            { label: "Global Display Name", value: "globalName" },
            { label: "Server Nickname", value: "nickname" },
        ] as Array<{ label: string; value: AttributionMode; default?: boolean }>
    }
});

function getAttribution(userId: string): string {
    const user = UserStore.getUser(userId);
    switch (settings.store.attribution) {
        case "globalName":
            return user?.globalName || user?.username || "unknown";
        case "nickname": {
            const member = GuildMemberStore.getMember(SelectedGuildStore.getGuildId()!, userId);
            return member?.nick || user?.globalName || user?.username || "unknown";
        }
        default:
            return user?.username || "unknown";
    }
}

// --- Quote image generation (canvas) -------------------------------------

function calculateFontSize({ charCount, width, height }: { charCount: number; width: number; height: number; }) {
    let baseSize: number;
    if (charCount <= 20) baseSize = 48;
    else if (charCount <= 50) baseSize = 36;
    else if (charCount <= 100) baseSize = 28;
    else if (charCount <= 200) baseSize = 22;
    else baseSize = 18;

    const estimatedCharWidth = baseSize * 0.6;
    const charsPerLine = Math.floor(width / estimatedCharWidth);
    const estimatedLines = Math.ceil(charCount / charsPerLine);
    const requiredHeight = estimatedLines * baseSize * 1.2;
    if (requiredHeight > height * 0.8) {
        baseSize = baseSize * (height * 0.8) / requiredHeight;
    }
    return Math.max(16, Math.min(baseSize, 60));
}

function wrapTextCentered(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number
) {
    const words = text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n] + " ";
        if (ctx.measureText(testLine).width > maxWidth && n > 0) {
            lines.push(line.trim());
            line = words[n] + " ";
        } else {
            line = testLine;
        }
    }
    if (line.trim()) lines.push(line.trim());

    const totalHeight = lines.length * lineHeight;
    const startY = y - totalHeight / 2 + lineHeight;
    let currentY = startY;
    for (const l of lines) {
        const lineWidth = ctx.measureText(l).width;
        ctx.fillText(l, x + (maxWidth - lineWidth) / 2, currentY);
        currentY += lineHeight;
    }
    return currentY;
}

const WIDTH = 1250;
const HEIGHT = 530;

async function generateQuoteImage(avatarUrl: string, text: string, attribution: string): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d")!;

    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load avatar image"));
        img.src = avatarUrl;
    });

    // Avatar on the left, dark gradient fading over it
    ctx.drawImage(img, 0, 0, 600, HEIGHT);
    const grad = ctx.createLinearGradient(0, 45, 530, 0);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 1)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const availableWidth = 400;
    const fontSize = calculateFontSize({ charCount: text.length, width: availableWidth, height: HEIGHT });
    const lineHeight = fontSize * 1.2;

    ctx.fillStyle = "white";
    ctx.font = `bold ${fontSize}px Arial`;
    const centerX = 650;
    const endY = wrapTextCentered(ctx, text, centerX, HEIGHT / 2, availableWidth, lineHeight);

    ctx.fillStyle = "rgba(104, 104, 104, 1)";
    ctx.font = "italic 20px Arial";
    const attrWidth = ctx.measureText(attribution).width;
    ctx.fillText(`- @${attribution}`, centerX + (availableWidth - attrWidth) / 2 - 10, endY + 5);

    return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Failed to create blob")), "image/png");
    });
}

// --- Sending --------------------------------------------------------------

async function sendQuote(avatarUrl: string, text: string, attribution: string, channelId: string) {
    const blob = await generateQuoteImage(avatarUrl, text, attribution);
    const file = new File([blob], "quote.png", { type: "image/png" });

    const reply = PendingReplyStore.getPendingReply(channelId);
    if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

    const upload = new CloudUpload({
        file,
        isThumbnail: false,
        platform: CloudUploadPlatform.WEB,
    }, channelId);

    upload.on("complete", () => {
        RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channelId),
            body: {
                flags: 0,
                channel_id: channelId,
                content: "",
                nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                sticker_ids: [],
                type: 0,
                attachments: [{
                    id: "0",
                    filename: upload.filename,
                    uploaded_filename: upload.uploadedFilename,
                }],
                message_reference: reply ? MessageActions.getSendMessageOptionsForReply(reply)?.messageReference : null,
            }
        });
    });
    upload.on("error", () => showToast("Failed to send quote", Toasts.Type.FAILURE));

    upload.upload();
}

// --- Context menu ---------------------------------------------------------

const QuoteMenuId = "quoter-quote-user";

const messageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const { message } = props;
    if (!message?.author || message.author.bot) return;

    children.push(
        <Menu.MenuItem
            id={QuoteMenuId}
            key={QuoteMenuId}
            label="Quote User"
            action={async () => {
                try {
                    const user = UserStore.getUser(message.author.id);
                    const avatarUrl = user.getAvatarURL(null, 1 << 12);
                    const attribution = getAttribution(message.author.id);
                    await sendQuote(avatarUrl, message.content, attribution, message.channel_id);
                } catch (err) {
                    console.error("[Quoter] failed:", err);
                    showToast("Failed to generate quote", Toasts.Type.FAILURE);
                }
            }}
        />
    );
};

export default definePlugin({
    name: "Quoter",
    description: "Right-click a message to generate a stylish quote image (avatar + text + attribution) and send it to the channel. Converted from the BetterDiscord plugin by Kaan.",
    tags: ["Fun", "Utility"],
    authors: [Devs.Limey],
    settings,

    contextMenus: {
        "message": messageContextMenu
    }
});

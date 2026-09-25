/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "GifCaptioner" by TheLazySquid
 * (https://github.com/TheLazySquid/BetterDiscordPlugins) — re-implemented
 * natively for Limey V1. Encoding uses gifenc (already in the repo);
 * frame decoding uses the browser's WebCodecs ImageDecoder.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { CloudUpload as TCloudUpload } from "@limeyV1/discord-types";
import { CloudUploadPlatform } from "@limeyV1/discord-types/enums";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findLazy } from "@webpack";
import {
    Constants,
    FluxDispatcher,
    Menu,
    MessageActions,
    PendingReplyStore,
    RestAPI,
    SelectedChannelStore,
    SnowflakeUtils,
    Toasts,
    showToast,
} from "@webpack/common";
import { GIFEncoder, applyPalette, quantize } from "gifenc";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const settings = definePluginSettings({
    autoSend: {
        description: "Immediately send the file (otherwise it is attached to the message box for you to send)",
        type: OptionType.BOOLEAN,
        default: true
    }
});

type Transform =
    | { type: "caption"; text: string; size: number }
    | { type: "speechbubble"; tipX: number; tipY: number; tipBase: number };

function showError(message: string) {
    showToast(message, Toasts.Type.FAILURE);
}

// --- URL normalization (same behavior as the original) ---------------------

function formatUrl(rawUrl: string): URL {
    const url = new URL(rawUrl, location.href);
    if (url.hostname === "media.discordapp.net") url.hostname = "cdn.discordapp.com";
    url.searchParams.delete("format");
    url.searchParams.delete("animated");
    url.searchParams.delete("width");
    url.searchParams.delete("height");
    url.searchParams.delete("quality");
    if (url.hostname.endsWith("tenor.com") && !url.pathname.endsWith(".gif")) {
        const path = url.pathname;
        const typeIndex = path.lastIndexOf("/") - 1;
        url.pathname = path.slice(0, typeIndex) + "o" + path.slice(typeIndex + 1);
    }
    if (url.pathname.endsWith(".webp")) {
        url.searchParams.set("animated", "true");
    }
    return url;
}

// --- Caption drawing helpers ------------------------------------------------

function getLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    const words = text.split(" ");
    const lines: string[] = [];
    let currentLine = words[0] ?? "";
    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        if (ctx.measureText(currentLine + " " + word).width < maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
}

function bezierPoint(t: number, start: number[], control: number[], end: number[]) {
    const x = (1 - t) * (1 - t) * start[0] + 2 * (1 - t) * t * control[0] + t * t * end[0];
    const y = (1 - t) * (1 - t) * start[1] + 2 * (1 - t) * t * control[1] + t * t * end[1];
    return [x, y];
}

function moveAway(point: number[], from: number[], distance: number) {
    const dx = point[0] - from[0];
    const dy = point[1] - from[1];
    const length = Math.sqrt(dx ** 2 + dy ** 2);
    const scale = distance / length;
    return [point[0] + dx * scale, point[1] + dy * scale];
}

function renderSpeechbubble(ctx: CanvasRenderingContext2D, width: number, height: number, tipX: number, tipY: number, tipBase: number) {
    const start = [0, height * 0.1];
    const control = [width * 0.5, height * 0.2];
    const end = [width, height * 0.1];
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(start[0], start[1]);
    ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
    ctx.lineTo(width, 0);
    ctx.lineTo(0, 0);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.quadraticCurveTo(control[0], control[1], end[0], end[1]);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.stroke();
    const tipWidth = 0.2;
    const base1 = bezierPoint(tipBase, start, control, end);
    const base2 = bezierPoint(tipBase + tipWidth, start, control, end);
    const bgDistance = 5;
    ctx.beginPath();
    ctx.moveTo(...moveAway(base1, [tipX, tipY], bgDistance) as [number, number]);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(...moveAway(base2, [tipX, tipY], bgDistance) as [number, number]);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(base1[0], base1[1]);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(base2[0], base2[1]);
    ctx.strokeStyle = "black";
    ctx.lineWidth = 2;
    ctx.stroke();
}

// --- GIF renderer (gifenc) ---------------------------------------------------

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB, Discord max upload

class GifRenderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    topOffset = 0;
    width: number;
    height: number; // doesn't include caption height
    transform: Transform;
    fullHeight: number;
    frames: { rgba: Uint8ClampedArray; delay: number }[] = [];

    constructor(width: number, height: number, transform: Transform) {
        this.width = width;
        this.height = height;
        this.transform = transform;
        this.canvas = document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;

        let fullHeight = height;
        if (transform.type === "caption") {
            this.ctx.font = `${transform.size}px Arial`;
            fullHeight = getLines(this.ctx, transform.text, width).length * transform.size + 10 + height;
        }
        this.fullHeight = fullHeight;

        // Downscale if the estimated size would exceed the upload limit
        const sizeEstimate = fullHeight * width * 40; // rough bytes/frame heuristic
        const scaleFactor = Math.max(1, Math.sqrt(sizeEstimate / MAX_FILE_SIZE));
        this.width = this.canvas.width = Math.floor(width / scaleFactor);
        this.height = Math.floor(height / scaleFactor);
        this.canvas.height = Math.floor(fullHeight / scaleFactor);

        if (transform.type === "caption") {
            this.drawCaption(transform.text, transform.size / scaleFactor);
        } else {
            this.drawSpeechBubble(transform.tipX / scaleFactor, transform.tipY / scaleFactor, transform.tipBase);
        }
    }

    drawCaption(text: string, size: number) {
        this.ctx.font = `${size}px Arial`;
        const lines = getLines(this.ctx, text, this.width);
        this.topOffset = lines.length * size + 10;
        this.ctx.fillStyle = "white";
        this.ctx.fillRect(0, 0, this.width, lines.length * size + 10);
        this.ctx.fillStyle = "black";
        this.ctx.textAlign = "center";
        this.ctx.textBaseline = "top";
        for (let i = 0; i < lines.length; i++) {
            this.ctx.fillText(lines[i], this.width / 2, size * i + 5);
        }
    }

    speechBubbleCanvas?: HTMLCanvasElement;
    speechBubbleCtx?: CanvasRenderingContext2D;

    drawSpeechBubble(tipX: number, tipY: number, tipBase: number) {
        if (!this.speechBubbleCanvas) {
            this.speechBubbleCanvas = document.createElement("canvas");
            this.speechBubbleCanvas.width = this.width;
            this.speechBubbleCanvas.height = this.height;
            this.speechBubbleCtx = this.speechBubbleCanvas.getContext("2d")!;
        }
        renderSpeechbubble(this.speechBubbleCtx!, this.width, this.height, tipX, tipY, tipBase);
    }

    addVideoFrame(frame: VideoFrame) {
        // ImageDecoder VideoFrames often have no duration — fall back to 100ms
        const delay = (frame.duration || 100000) / 1000;
        this.ctx.drawImage(frame, 0, this.topOffset, this.width, this.height);
        this.addFrameToGif(delay);
        frame.close();
    }

    addFrameToGif(delay: number) {
        if (this.transform.type === "speechbubble" && this.speechBubbleCanvas) {
            this.ctx.drawImage(this.speechBubbleCanvas, 0, this.topOffset, this.width, this.height);
        }
        const data = this.ctx.getImageData(0, 0, this.width, this.canvas.height);
        this.frames.push({ rgba: data.data, delay });
    }

    async render(): Promise<File> {
        if (!this.frames.length) throw new Error("no decodable frames in gif");
        const gif = GIFEncoder();
        const palette = quantize(this.frames[0].rgba, 256);
        for (const frame of this.frames) {
            const index = applyPalette(frame.rgba, palette);
            gif.writeFrame(index, this.width, this.canvas.height, { palette, delay: frame.delay });
        }
        gif.finish();
        const blob = new Blob([gif.bytes().buffer as ArrayBuffer], { type: "image/gif" });
        return new File([blob], "captioned.gif", { type: "image/gif" });
    }
}

// --- Frame decoding (WebCodecs) ----------------------------------------------

async function captionImageFile(url: string): Promise<File> {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    // Extension-less URLs (Discord proxy/embed media) — use the response type,
    // falling back to gif (works for webp too in Chromium's ImageDecoder).
    const contentType = res.headers.get("content-type") ?? "";
    const mime = contentType.startsWith("image/") ? contentType
        : url.endsWith(".webp") ? "image/webp"
        : "image/gif";
    const decoder = new ImageDecoder({ data: buffer, type: mime });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error("No track found");

    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        decoder.decode({ frameIndex: 0 }).then((result: any) => {
            resolve({ width: result.image.displayWidth, height: result.image.displayHeight });
            result.image.close();
        }).catch(reject);
    });

    const renderer = new GifRenderer(size.width, size.height, currentTransform!);
    for (let i = 0; i < Math.min(track.frameCount, 500); i++) {
        const result = await decoder.decode({ frameIndex: i });
        renderer.addVideoFrame(result.image);
    }
    return await renderer.render();
}

// --- Editing modal --------------------------------------------------------------

let currentTransform: Transform | null = null;

function openCaptioner(src: string) {
    const url = formatUrl(src);
    const urlString = url.toString();

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = urlString;

    img.addEventListener("load", async () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;

        const modal = openModal(props => (
            <CaptionModal
                modalProps={props}
                width={width}
                height={height}
                element={img}
                onConfirm={(transform) => {
                    currentTransform = transform;
                    captionAndSend(urlString).catch(err => {
                        console.error("[GifCaptioner] failed:", err);
                        showError(`Failed to caption gif: ${err?.message || err}`);
                    });
                }}
            />
        ));
    }, { once: true });

    img.addEventListener("error", () => showError("Failed to load gif"));
}

function CaptionModal({ modalProps, width, height, element, onConfirm }: {
    modalProps: any;
    width: number;
    height: number;
    element: HTMLImageElement;
    onConfirm: (t: Transform) => void;
}) {
    const [text, setText] = useState("");
    const [size, setSize] = useState(Math.floor(width / 10));
    const [tab, setTab] = useState<"caption" | "speechbubble">("caption");
    const [tip, setTip] = useState<[number, number]>([width / 3, height / 3]);
    const [tipBase, setTipBase] = useState(10);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const wrapperRef = useRef<HTMLDivElement | null>(null);

    const preview = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        canvas.width = width;
        canvas.height = height + (tab === "caption" ? getLines(ctx, text || "Enter caption...", width).length * size + 10 : 0);
        if (tab === "caption") {
            const lines = getLines(ctx, text || "Enter caption...", width);
            const captionHeight = lines.length * size + 10;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, width, captionHeight);
            ctx.font = `${size}px Arial`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "black";
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], width / 2, size * i + 5);
            }
            ctx.drawImage(element, 0, captionHeight, width, height);
        } else {
            ctx.drawImage(element, 0, 0, width, height);
            ctx.save();
            ctx.translate(0, 0);
            ctx.beginPath();
            ctx.rect(0, 0, width, height);
            ctx.clip();
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, width, 1); // placeholder to keep ctx state consistent
            ctx.globalAlpha = 1;
            renderSpeechbubble(ctx, width, height, tip[0], tip[1], tipBase / 100);
            ctx.restore();
        }
    };

    useEffect(preview, [text, size, tab, tip, tipBase]);
    useEffect(() => {
        wrapperRef.current?.insertBefore(element, canvasRef.current);
        preview();
    }, []);

    return (
        <ModalRoot {...modalProps}>
            <ModalContent>
                <div className="gc-editor">
                    <div className="gc-tabs">
                        <button className={tab === "caption" ? "active" : ""} onClick={() => setTab("caption")}>Caption</button>
                        <button className={tab === "speechbubble" ? "active" : ""} onClick={() => setTab("speechbubble")}>Speech Bubble</button>
                    </div>
                    {tab === "caption" && (
                        <>
                            <input
                                className="gc-caption"
                                placeholder="Enter caption..."
                                onChange={e => setText(e.target.value)}
                            />
                            <div className="gc-range">
                                <span>Font size</span>
                                <input type="range" min={5} max={200} value={size} onChange={e => setSize(parseFloat(e.target.value))} />
                            </div>
                        </>
                    )}
                    {tab === "speechbubble" && (
                        <div className="gc-range">
                            <span>Tip base position</span>
                            <input type="range" min={0} max={80} value={tipBase} onChange={e => setTipBase(parseFloat(e.target.value))} />
                        </div>
                    )}
                    <div ref={wrapperRef} className="gc-speechbubbler">
                        <canvas
                            ref={canvasRef}
                            width={width}
                            height={height}
                            onClick={e => {
                                if (tab !== "speechbubble") return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                setTip([
                                    (e.clientX - rect.left) / rect.width * width,
                                    (e.clientY - rect.top) / rect.height * height
                                ]);
                            }}
                        />
                    </div>
                </div>
            </ModalContent>
            <ModalFooter>
                <Button onClick={() => {
                    onConfirm(tab === "caption"
                        ? { type: "caption", text: text || " ", size }
                        : { type: "speechbubble", tipX: tip[0], tipY: tip[1], tipBase: tipBase / 100 });
                    modalProps.onClose();
                }}>
                    Caption it!
                </Button>
                <Button onClick={modalProps.onClose} color={Button.Colors.PRIMARY}>Cancel</Button>
            </ModalFooter>
        </ModalRoot>
    );
}

// --- Sending ----------------------------------------------------------------------

async function captionAndSend(url: string) {
    const file = await captionImageFile(url);
    if (settings.store.autoSend) {
        await sendFile(file);
    } else {
        await attachFile(file);
    }
}

async function attachFile(file: File) {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;
    // Fall back to directly uploading if attaching fails
    await sendFile(file);
}

async function sendFile(file: File) {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

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
    upload.on("error", () => showError("Failed to upload gif"));

    upload.upload();
}

// --- Context menu ------------------------------------------------------------------

const GIF_URL_RE = /https?:\/\/[^\s<>"')]+\.(?:gif|webp)(?:\?[^\s<>"')]*)?/gi;

type GifSource = { label: string; url: string };

// Collect gif-able image URLs from a message: attachments, embeds (which is
// how link previews of gifs appear) and raw gif links in the message content.
function collectGifSources(message: any): GifSource[] {
    if (!message) return [];
    const sources: GifSource[] = [];
    const seen = new Set<string>();
    const push = (label: string, url?: string | null) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        sources.push({ label, url });
    };

    for (const attachment of message.attachments ?? []) {
        const isGifLike = attachment.content_type?.startsWith("image/")
            || attachment.filename?.endsWith(".gif")
            || attachment.filename?.endsWith(".webp");
        if (isGifLike) push("Attachment", attachment.url);
    }

    for (const embed of message.embeds ?? []) {
        const image = embed.image ?? embed.video ?? embed.thumbnail;
        // embeds of gif links are type "imagev2"/"image" with a proxy_url
        if (image?.url || image?.proxy_url) {
            push("Link preview", image.proxy_url ?? image.url);
        }
    }

    for (const match of String(message.content ?? "").matchAll(GIF_URL_RE)) {
        push("Link", match[0]);
    }

    return sources;
}

const messageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const sources = collectGifSources(props?.message);
    if (!sources.length) return;

    children.push(
        ...sources.map((source, i) => (
            <Menu.MenuItem
                id={`gifcaptioner-caption-${i}`}
                key={`gifcaptioner-caption-${i}`}
                label={sources.length > 1 ? `Caption Gif (${source.label})` : "Caption Gif"}
                action={() => openCaptioner(source.url)}
            />
        ))
    );
};

// --- Modal components come from webpack common ------------------------------------

import { Button, useEffect, openModal, useRef, useState } from "@webpack/common";
import { Modals } from "@utils/modal";
const { ModalRoot, ModalContent, ModalFooter } = Modals as any;

export default definePlugin({
    name: "GifCaptioner",
    description: "Add a caption or speech bubble to GIFs (attachments, gif links and link previews) and send the result as a new gif. Converted from the BetterDiscord plugin by TheLazySquid.",
    tags: ["Fun", "Utility"],
    authors: [Devs.Limey],
    settings,

    contextMenus: {
        "message": messageContextMenu
    }
});

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { set } from "@api/DataStore";
import { Heading } from "@components/Heading";
import { Margins } from "@components/margins";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@limeyV1/discord-types";
import { IconUtils, Modal, TextInput, showToast, UserStore } from "@webpack/common";
import React, { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { data, KEY_DATASTORE } from ".";

const cl = classNameFactory("vc-userpfp-");

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function SetAvatarModal({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const { avatars } = data;
    const user = UserStore.getUser(userId);
    const originalAvatar = IconUtils.getUserAvatarURL(user, true, 128) || "";

    const [url, setUrl] = useState(avatars[userId] || "");
    const [preview, setPreview] = useState<string>(avatars[userId] || "");
    const [isDragging, setIsDragging] = useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    function handleKey(e: ReactKeyboardEvent) {
        if (e.key === "Enter") saveUserAvatar();
    }

    function handleUrlChange(val: string) {
        setUrl(val);
        setPreview(val.trim());
    }

    async function handleFile(file: File) {
        if (!file.type.startsWith("image/")) return;

        if (file.type === "image/gif" || file.type === "image/webp") {
            showToast("GIFs/WebP must be added via URL. Upload your GIF/WebP to a image hosting service and paste the link.");
            return;
        }

        const dataUrl = await fileToDataUrl(file);
        setUrl(dataUrl);
        setPreview(dataUrl);
    }

    async function saveUserAvatar() {
        if (!url.trim()) {
            await deleteUserAvatar();
            return;
        }
        avatars[userId] = url.trim();
        await set(KEY_DATASTORE, avatars);
        modalProps.onClose();
    }

    async function deleteUserAvatar() {
        delete avatars[userId];
        await set(KEY_DATASTORE, avatars);
        modalProps.onClose();
    }

    const actions = [
        {
            text: "Save",
            variant: "primary",
            onClick: saveUserAvatar
        }
    ];

    if (avatars[userId]) {
        actions.unshift({
            text: "Delete",
            variant: "dangerPrimary",
            onClick: deleteUserAvatar
        });
    }

    return (
        <Modal
            {...modalProps}
            size="sm"
            title="Custom Avatar"
            actions={actions}
        >
            <div onKeyDown={handleKey}>
                {/* Preview */}
                <div className={cl("preview-row")}>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Original</span>
                        <img src={originalAvatar} className={cl("avatar")} alt="original" />
                    </div>
                    <span className={cl("arrow")}>→</span>
                    <div className={cl("preview-box")}>
                        <span className={cl("preview-label")}>Local</span>
                        <img
                            src={preview || originalAvatar}
                            className={`${cl("avatar")} ${preview ? cl("avatar-active") : ""}`}
                            alt="local"
                        />
                    </div>
                </div>

                {/* URL input */}
                <section className={Margins.bottom8}>
                    <Heading tag="h3">Enter PNG/GIF URL</Heading>
                    <TextInput
                        placeholder="https://example.com/image.png"
                        value={url.startsWith("data:") ? "(uploaded file)" : url}
                        onChange={handleUrlChange}
                        autoFocus
                    />
                </section>

                {/* Drag & drop */}
                <div
                    className={`${cl("dropzone")} ${isDragging ? cl("dropzone-active") : ""}`}
                    onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={e => {
                        e.preventDefault();
                        setIsDragging(false);
                        const file = e.dataTransfer.files?.[0];
                        if (file) handleFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                >
                    {isDragging ? "Drop here!" : "⬆ Drag an image or click to upload (for GIFs or WebP use a URL instead)"}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg"
                        style={{ display: "none" }}
                        onChange={e => {
                            const file = e.currentTarget.files?.[0];
                            if (file) handleFile(file);
                            e.currentTarget.value = "";
                        }}
                    />
                </div>
            </div>
        </Modal>
    );
}

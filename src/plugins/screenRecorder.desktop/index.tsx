/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, removeContextMenuPatch } from "@api/ContextMenu";
import { ScreenshareIcon } from "@components/Icons";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Menu, UploadHandler } from "@webpack/common";

let recoder: MediaRecorder;

export default definePlugin({
    name: "ScreenRecorder",
    permissions: [
        {
            id: "screenCapture",
            title: "Capture your screen",
            description: "Records the screen or window you explicitly pick when you press record.",
            risk: "Recordings can contain anything you share on screen — review before uploading."
        },
        {
            id: "fileAccess",
            title: "Read and package files",
            description: "Encodes your recording locally and attaches it as a message file.",
            risk: "Files you attach are repackaged — verify the output before sending."
        },
        {
            id: "networkRequests",
            title: "Make network requests",
            description: "Uploads your recording to the channel through Discord's own attachment API.",
            risk: "Requests are made with your session; destinations see your IP address."
        }
    ],
    description: "Adds an option to record your screen and upload the recording to the channel",
    tags: ["Chat"],
    authors: [Devs.AutumnVN],
    contextMenus: {
        "channel-attach": startRecording
    }
});

function startRecording(children) {
    children.push(
        <Menu.MenuItem
            id="start-recording"
            label={
                <div>
                    <ScreenshareIcon height={24} width={24} />
                    <div>Start Recording</div>
                </div>
            }
            action={async () => {
                const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: { ideal: 60 } } });
                recoder = new MediaRecorder(stream);
                recoder.start();
                removeContextMenuPatch("channel-attach", startRecording);
                addContextMenuPatch("channel-attach", stopRecording);
            }}
        />
    );
}

function stopRecording(children, props) {
    children.push(
        <Menu.MenuItem
            id="stop-recording"
            label={
                <div>
                    <ScreenshareIcon height={24} width={24} />
                    <div>Stop Recording</div>
                </div>
            }
            action={() => {
                recoder.addEventListener("dataavailable", e => {
                    const file = new File([e.data], "recording.webm", { type: "video/webm" });
                    UploadHandler.promptToUpload([file], props.channel, 0);
                });
                recoder.stop();
                removeContextMenuPatch("channel-attach", stopRecording);
                addContextMenuPatch("channel-attach", startRecording);
            }}
        />
    );
}

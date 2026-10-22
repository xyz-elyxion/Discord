/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button, Heading, Paragraph, TextButton } from "@vencord/types/components";
import { Margins, useForceUpdater } from "@vencord/types/utils";
import { Modal, openModal, Toasts } from "@vencord/types/webpack/common";
import { Settings } from "shared/settings";

import { cl, SettingsComponent } from "./Settings";

export const DeveloperOptionsButton: SettingsComponent = ({ settings }) => {
    return <Button onClick={() => openDeveloperOptionsModal(settings)}>Open Developer Settings</Button>;
};

function openDeveloperOptionsModal(settings: Settings) {
    openModal(props => (
        <Modal {...props} size="lg" title="Limey V1 Desktop Developer Options">
            <Heading tag="h4">Limey V1 Location</Heading>
            <LimeyV1LocationPicker settings={settings} />

            <Heading tag="h4" className={Margins.top16}>
                Debugging
            </Heading>
            <div className={cl("button-grid")}>
                <Button onClick={() => LimeyV1Native.debug.launchGpu()}>Open chrome://gpu</Button>
                <Button onClick={() => LimeyV1Native.debug.launchWebrtcInternals()}>
                    Open chrome://webrtc-internals
                </Button>
            </div>
        </Modal>
    ));
}

const LimeyV1LocationPicker: SettingsComponent = ({ settings }) => {
    const forceUpdate = useForceUpdater();
    const usingCustomLimeyDir = LimeyV1Native.fileManager.isUsingCustomLimeyDir();

    return (
        <>
            <Paragraph>
                Limey V1 files are loaded from{" "}
                {usingCustomLimeyDir ? (
                    <TextButton
                        variant="link"
                        onClick={e => {
                            e.preventDefault();
                            LimeyV1Native.fileManager.showCustomLimeyDir();
                        }}
                    >
                        a custom location
                    </TextButton>
                ) : (
                    "the default location"
                )}
            </Paragraph>
            <div className={cl("button-grid")}>
                <Button
                    onClick={async () => {
                        const choice = await LimeyV1Native.fileManager.selectLimeyDir();
                        switch (choice) {
                            case "cancelled":
                                break;
                            case "ok":
                                Toasts.show({
                                    message: "Limey V1 install changed. Fully restart Limey V1 Desktop to apply.",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.SUCCESS
                                });
                                break;
                            case "invalid":
                                Toasts.show({
                                    message:
                                        "You did not choose a valid Limey V1 install. Make sure you're selecting the dist dir!",
                                    id: Toasts.genId(),
                                    type: Toasts.Type.FAILURE
                                });
                                break;
                        }
                        forceUpdate();
                    }}
                >
                    Change
                </Button>
                <Button
                    variant="dangerPrimary"
                    onClick={async () => {
                        await LimeyV1Native.fileManager.selectLimeyDir(null);
                        forceUpdate();
                    }}
                >
                    Reset
                </Button>
            </div>
        </>
    );
};

/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin, { IconComponent } from "@utils/types";
import { Modal, openModal } from "@webpack/common";

import { CompanionModal } from "./CompanionModal";

/** Simple lemon icon used for the Settings UI */
const CompanionIcon: IconComponent = ({ height = 24, width = 24, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className}>
        <text x="2" y="19" fontSize="18">🍋</text>
    </svg>
);

function openCompanionModal() {
    openModal(props => (
        <Modal
            {...props}
            title="🍋 Limey Companion"
            subtitle="Ask me anything about Discord or Limey V1"
        >
            <CompanionModal />
        </Modal>
    ));
}

function CompanionButton({ isMainChat }: { isMainChat: boolean; }) {
    if (!isMainChat) return null;

    return (
        <div
            role="button"
            aria-label="Ask the Limey Companion"
            title="Ask the Limey Companion"
            onClick={openCompanionModal}
            style={{ cursor: "pointer", fontSize: "20px", lineHeight: "24px", userSelect: "none" }}
        >
            🍋
        </div>
    );
}

export default definePlugin({
    name: "LimeyCompanion",
    description: "Your little Limey companion: ask it questions about Discord or Limey V1 and it answers with the best-matching predefined sentence. Click the lemon in the chat bar to chat with it.",
    authors: [Devs.Limey],
    tags: ["Utility", "Fun", "Chat"],
    chatBarButton: {
        icon: CompanionIcon,
        render: CompanionButton,
    },
});

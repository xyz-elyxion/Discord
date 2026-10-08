/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { ComponentType } from "react";

import { KaomojiIcon, KaomojiPicker, KaomojiPickerButton } from "./components";
import { ExpressionPickerTabProps, ExpressionPickerView } from "./types";

export default definePlugin({
    name: "BringBackKaomojiPicker",
    description: "Adds the Kaomoji tab back to Discord's expression picker.",
    authors: [Devs.Kaede, Devs.Limey],
    patches: [
        {
            find: "#{intl::EXPRESSION_PICKER_CATEGORIES_A11Y_LABEL}",
            replacement: [
                {
                    match: /\(0,\i\.jsx\)\((\i),[^}]{20,40}?"aria-selected":(\i)[^}]{50,100}?#{intl::EXPRESSION_PICKER_GIF}\)\}\)/,
                    replace: "$self.renderTabs($1,$2)",
                },
                {
                    match: /\{onSelectGIF:(\i),[^}]{20,40}\}\):null,(?=(\i)===)/,
                    replace: "$&$self.renderKaomojiPicker($2),"
                },
            ],
            group: true,
        },
    ],
    tags: ["Chat", "Utility"],
    chatBarButton: {
        icon: KaomojiIcon,
        render: KaomojiPickerButton,
    },
    renderTabs(
        Tab: ComponentType<ExpressionPickerTabProps>,
        activeView: ExpressionPickerView,
    ) {
        return (
            <>
                <Tab
                    id="gif-picker-tab"
                    key="gif-picker-tab"
                    aria-controls="gif-picker-tab-panel"
                    aria-selected={activeView === ExpressionPickerView.GIF}
                    isActive={activeView === ExpressionPickerView.GIF}
                    viewType={ExpressionPickerView.GIF}
                >
                    GIFs
                </Tab>
                <Tab
                    id="kaomoji-picker-tab"
                    key="kaomoji-picker-tab"
                    aria-controls="kaomoji-picker-tab-panel"
                    aria-selected={activeView === ExpressionPickerView.KAOMOJI}
                    isActive={activeView === ExpressionPickerView.KAOMOJI}
                    viewType={ExpressionPickerView.KAOMOJI}
                >
                    ^▽^
                </Tab>
            </>
        );
    },
    renderKaomojiPicker(activeView: ExpressionPickerView) {
        if (activeView !== ExpressionPickerView.KAOMOJI) return null;

        return <KaomojiPicker />;
    }
});

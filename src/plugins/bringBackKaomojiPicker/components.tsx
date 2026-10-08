/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton } from "@api/ChatButtons";
import { getCurrentChannel, insertTextIntoChatInputBox } from "@utils/discord";
import { IconComponent } from "@utils/types";
import { Button, ExpressionPickerStore, TextInput, useEffect, useMemo, useRef, useState } from "@webpack/common";

import kaomojiData from "./kaomojis.json";
import { ExpressionPickerView, KaomojiCategories } from "./types";

function insertKaomoji(text: string) {
    insertTextIntoChatInputBox(text);
}

export const KaomojiIcon: IconComponent = ({
    height = 24,
    width = 24,
    className,
}) => (
    <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        className={className}
        style={{ transform: "scale(1.2)" }}
        fill="var(--icon-default)"
        stroke="currentColor"
        strokeWidth="0.6"
        strokeLinecap="round"
        strokeLinejoin="round"
    >
        <path d="M6.5 17q-.65 0-1.075-.425T5 15.5q0-.625.425-1.062T6.5 14q.625 0 1.063.438T8 15.5q0 .65-.437 1.075T6.5 17m0-7q-.65 0-1.075-.425T5 8.5q0-.625.425-1.062T6.5 7q.625 0 1.063.438T8 8.5q0 .65-.437 1.075T6.5 10m4.5 3q-.425 0-.712-.288T10 12t.288-.712T11 11h2q.425 0 .713.288T14 12t-.288.713T13 13zm6-1q0-1.35-.363-2.6t-1.062-2.3q-.225-.35-.2-.775t.35-.7t.725-.213t.65.413q.9 1.325 1.4 2.887T19 12q0 1.4-.337 2.675t-.938 2.425q-.2.375-.6.475t-.75-.125t-.437-.637t.112-.788q.45-.925.7-1.925T17 12" />
    </svg>
);

export function KaomojiPickerButton({ isMainChat, type }: { isMainChat: boolean; type?: unknown; }) {
    if (!isMainChat || !type) return null;

    return (
        <ChatBarButton
            tooltip="Open Kaomoji Picker"
            onClick={() => {
                ExpressionPickerStore.openExpressionPicker(ExpressionPickerView.KAOMOJI, type, getCurrentChannel()?.id.toString());
            }}
        >
            <KaomojiIcon />
        </ChatBarButton>
    );
}

export function KaomojiPicker({
    onSelect,
}: {
    onSelect?: (kaomoji: string) => void;
}) {
    const [search, setSearch] = useState("");
    const [activeCategory, setActiveCategory] = useState<string>("all");

    const categories = useMemo(() => Object.keys(kaomojiData as KaomojiCategories), []);

    const filtered = useMemo(() => {
        const query = search.toLowerCase().trim();
        return Object.entries(kaomojiData as KaomojiCategories).flatMap(([category, list]) =>
            (activeCategory === "all" || activeCategory === category)
                ? list
                    .filter(item => !query || item.name.toLowerCase().includes(query) || item.kaomoji.includes(query))
                    .map(item => ({ category, item }))
                : []
        );
    }, [search, activeCategory]);

    const scrollerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    }, [filtered]);

    const handleSelect = (kaomoji: string) => {
        insertKaomoji(kaomoji);
        ExpressionPickerStore.closeExpressionPicker();
        onSelect?.(kaomoji);
    };

    const kaomojiList = filtered.length > 0 ? (
        <div
            style={{
                width: "100%",
                minWidth: 0,
                display: "grid",
                gap: "8px",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(115px, 100%), 1fr))",
            }}
        >
            {filtered.map(({ item }, index) => (
                <Button
                    key={`${item.name}-${index}`}
                    size={Button.Sizes.MEDIUM}
                    color={Button.Colors.PRIMARY}
                    title={item.name}
                    onClick={() => handleSelect(item.kaomoji)}
                    style={{
                        minWidth: 0,
                        maxWidth: "100%",
                        width: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                    }}
                >
                    {item.kaomoji}
                </Button>
            ))}
        </div>
    ) : (
        <div
            style={{
                display: "flex",
                justifyContent: "center",
                alignItems: "center",
                width: "100%",
                minWidth: 0,
                minHeight: 80,
                padding: "16px",
                boxSizing: "border-box",
            }}
        >
            No kaomoji meets the search criteria.
        </div>
    );

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                gap: "10px",
                width: "100%",
                height: "100%",
                minWidth: 0,
                minHeight: 400,
                maxWidth: "100%",
                padding: "12px",
                boxSizing: "border-box",
                overflow: "hidden",
            }}
        >
            <TextInput
                placeholder="Search Kaomoji..."
                value={search}
                onChange={setSearch}
                autoFocus
                style={{
                    width: "100%",
                    minWidth: 0,
                    maxWidth: "100%",
                    boxSizing: "border-box",
                }}
            />

            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", flexShrink: 0 }}>
                <Button
                    size={Button.Sizes.SMALL}
                    color={activeCategory === "all" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => setActiveCategory("all")}
                >
                    All
                </Button>

                {categories.map(category => (
                    <Button
                        key={category}
                        size={Button.Sizes.SMALL}
                        color={activeCategory === category ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                        onClick={() => setActiveCategory(category)}
                    >
                        {category}
                    </Button>
                ))}
            </div>

            <div
                ref={scrollerRef}
                className="kaomoji-picker-scrollbar"
                role="region"
                style={{
                    overflowY: "auto",
                    scrollbarWidth: "thin",
                    scrollbarColor: "var(--background-modifier-accent, #4e5058) var(--background-primary, #1e1f2e)",
                    width: "100%",
                    maxWidth: "100%",
                    minWidth: 0,
                    minHeight: 0,
                    flex: "1 1 0",
                    overflowX: "hidden",
                }}
            >
                {kaomojiList}
            </div>
        </div>
    );
}

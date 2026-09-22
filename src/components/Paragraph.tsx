/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2025 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText, type BaseTextProps } from "./BaseText";

export type ParagraphProps = BaseTextProps<"p">;

export function Paragraph({ children, ...restProps }: ParagraphProps) {
    return (
        <BaseText tag="p" size="sm" weight="normal" {...restProps}>
            {children}
        </BaseText>
    );
}

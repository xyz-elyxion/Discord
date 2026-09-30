/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./Item.css";

import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import type { ComponentPropsWithRef } from "react";

const cl = classNameFactory("vc-item-");

export interface ItemProps extends ComponentPropsWithRef<"div"> {
    variant?: "normal" | "outline";
}

/**
 * A row-style content block: content (title/description) on one side,
 * optional actions on the other. Mirrors the shadcn "item" layout in
 * Discord's own design language.
 */
export function Item({ variant = "normal", className, children, ...restProps }: ItemProps) {
    return (
        <div className={classes(cl("base", variant), className)} {...restProps}>
            {children}
        </div>
    );
}

export function ItemContent({ className, children, ...restProps }: ComponentPropsWithRef<"div">) {
    return (
        <div className={classes(cl("content"), className)} {...restProps}>
            {children}
        </div>
    );
}

export function ItemTitle({ className, children, ...restProps }: ComponentPropsWithRef<"div">) {
    return (
        <div className={classes(cl("title"), className)} {...restProps}>
            {children}
        </div>
    );
}

export function ItemDescription({ className, children, ...restProps }: ComponentPropsWithRef<"div">) {
    return (
        <div className={classes(cl("description"), className)} {...restProps}>
            {children}
        </div>
    );
}

export function ItemActions({ className, children, ...restProps }: ComponentPropsWithRef<"div">) {
    return (
        <div className={classes(cl("actions"), className)} {...restProps}>
            {children}
        </div>
    );
}

export function ItemMedia({ className, children, ...restProps }: ComponentPropsWithRef<"div">) {
    return (
        <div className={classes(cl("media"), className)} {...restProps}>
            {children}
        </div>
    );
}

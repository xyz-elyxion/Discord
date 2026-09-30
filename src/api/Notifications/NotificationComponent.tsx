/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2023 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import "./styles.css";

import { useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { React, useEffect, useMemo, useState, useStateFromStores, WindowStore } from "@webpack/common";

import { NotificationData, NotificationVariant } from "./Notifications";

function VariantIcon({ variant }: { variant: NotificationVariant; }) {
    const paths: Record<NotificationVariant, { d: string; circle?: string; }> = {
        // lucide CircleCheck
        success: { d: "M21.801 10A10 10 0 1 1 17 3.335 m9 11 3 3L22 4" },
        // lucide Info
        info: { d: "M12 16v-4", circle: "M12 8h.01" },
        // lucide TriangleAlert
        warning: { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01" },
        // lucide CircleAlert
        error: { d: "M12 8v4", circle: "M12 16h.01" },
    };

    const { d, circle } = paths[variant];
    return (
        <svg
            className={`vc-notification-variant-icon vc-notification-variant-${variant}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d={d} />
            {circle && <path d={circle} />}
        </svg>
    );
}

const VARIANT_CLASS: Record<NotificationVariant, string> = {
    success: "vc-notification-variant-success",
    info: "vc-notification-variant-info",
    warning: "vc-notification-variant-warning",
    error: "vc-notification-variant-error",
};

export default ErrorBoundary.wrap(function NotificationComponent({
    title,
    body,
    richBody,
    color,
    icon,
    variant,
    onClick,
    onClose,
    image,
    permanent,
    className,
    dismissOnClick
}: NotificationData & { className?: string; }) {
    const { timeout, position } = useSettings(["notifications.timeout", "notifications.position"]).notifications;
    const hasFocus = useStateFromStores([WindowStore], () => WindowStore.isFocused());

    const [isHover, setIsHover] = useState(false);
    const [elapsed, setElapsed] = useState(0);

    const start = useMemo(() => Date.now(), [timeout, isHover, hasFocus]);

    useEffect(() => {
        if (isHover || !hasFocus || timeout === 0 || permanent) return void setElapsed(0);

        const intervalId = setInterval(() => {
            const elapsed = Date.now() - start;
            if (elapsed >= timeout)
                onClose!();
            else
                setElapsed(elapsed);
        }, 10);

        return () => clearInterval(intervalId);
    }, [timeout, isHover, hasFocus]);

    const timeoutProgress = elapsed / timeout;

    return (
        <button
            className={classes(
                "vc-notification-root",
                variant && VARIANT_CLASS[variant],
                className
            )}
            style={position === "bottom-right" ? { bottom: "1rem" } : { top: "3rem" }}
            onClick={() => {
                onClick?.();
                if (dismissOnClick !== false)
                    onClose!();
            }}
            onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                onClose!();
            }}
            onMouseEnter={() => setIsHover(true)}
            onMouseLeave={() => setIsHover(false)}
        >
            <div className="vc-notification">
                {icon
                    ? <img className="vc-notification-icon" src={icon} alt="" />
                    : (variant && <VariantIcon variant={variant} />)}
                <div className="vc-notification-content">
                    <div className="vc-notification-header">
                        <h2 className="vc-notification-title">{title}</h2>
                        <button
                            className="vc-notification-close-btn"
                            aria-label="Dismiss"
                            onClick={e => {
                                e.preventDefault();
                                e.stopPropagation();
                                onClose!();
                            }}
                        >
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                role="img"
                                aria-labelledby="vc-notification-dismiss-title"
                            >
                                <title id="vc-notification-dismiss-title">Dismiss Notification</title>
                                <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    {richBody ?? <p className="vc-notification-p">{body}</p>}
                </div>
            </div>
            {image && <img className="vc-notification-img" src={image} alt="" />}
            {timeout !== 0 && !permanent && (
                <div
                    className="vc-notification-progressbar"
                    style={{ width: `${(1 - timeoutProgress) * 100}%`, backgroundColor: color || "var(--vc-notif-accent, var(--brand-500))" }}
                />
            )}
        </button>
    );
}, {
    onError: ({ props }) => props.onClose!()
});

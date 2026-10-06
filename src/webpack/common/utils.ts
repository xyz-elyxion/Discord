/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey and contributors
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

import type * as t from "@limeyV1/discord-types";
import { _resolveReady, filters, findByCodeLazy, findByPropsLazy, findLazy, mapMangledModuleLazy, waitFor } from "@webpack";
import type * as TSPattern from "ts-pattern";

export let FluxDispatcher: t.FluxDispatcher;
waitFor(["dispatch", "subscribe"], m => {
    FluxDispatcher = m;
    // Importing this directly causes all webpack commons to be imported, which can easily cause circular dependencies.
    // For this reason, use a non import access here.
    LimeyV1.Api.PluginManager.subscribeAllPluginsFluxEvents(m);

    const cb = () => {
        m.unsubscribe("CONNECTION_OPEN", cb);
        _resolveReady();
    };
    m.subscribe("CONNECTION_OPEN", cb);
});

export let ComponentDispatch: any;
waitFor(["dispatchToLastSubscribed"], m => ComponentDispatch = m);

export const Constants: t.Constants = mapMangledModuleLazy('ME:"/users/@me"', {
    Endpoints: filters.byProps("USER", "ME"),
    UserFlags: filters.byProps("STAFF", "SPAMMER"),
    FriendsSections: m => m.PENDING === "PENDING" && m.ADD_FRIEND
});

export const RestAPI: t.RestAPI = findLazy(m => typeof m === "object" && m.del && m.put);
export const moment: typeof import("moment") = findByPropsLazy("parseTwoDigitYear");

export const { match, P }: { match: typeof TSPattern["match"], P: typeof TSPattern["P"]; } = mapMangledModuleLazy("@ts-pattern/matcher", {
    match: filters.byCode("return new"),
    P: filters.byProps("when")
});

export const lodash: typeof import("lodash") = findByPropsLazy("debounce", "cloneDeep");

export const i18n = mapMangledModuleLazy(['defaultLocale:"en-US"', /initialLocale:\i/], {
    t: m => m?.[Symbol.toStringTag] === "IntlMessagesProxy",
    intl: m => m != null && Object.getPrototypeOf(m)?.withFormatters != null
}, true);

export let SnowflakeUtils: t.SnowflakeUtils;
waitFor(["fromTimestamp", "extractTimestamp"], m => SnowflakeUtils = m);

export let Parser: t.Parser;
waitFor("parseTopic", m => Parser = m);
export let Alerts: t.Alerts;
waitFor(["show", "close"], m => Alerts = m);

const ToastType = {
    MESSAGE: "message",
    SUCCESS: "success",
    FAILURE: "failure",
    CUSTOM: "custom",
    CLIP: "clip",
    LINK: "link",
    FORWARD: "forward",
    BOOKMARK: "bookmark",
    CLOCK: "clock"
};

const ToastPosition = {
    TOP: 0,
    BOTTOM: 1
};

export interface ToastData {
    message: string,
    id: string,
    /**
     * Toasts.Type
     */
    type: string,
    options?: ToastOptions;
}

export interface ToastOptions {
    /**
     * Toasts.Position
     */
    position?: number;
    component?: React.ReactNode,
    duration?: number;
}

interface ToastsExports {
    showToast: (data: ToastData) => void;
    popToast(): void;
}


const ToastsExports = mapMangledModuleLazy(".currentToastMap.has(", {
    showToast: filters.byCode(".currentToastMap.has("),
    popToast: filters.byCode(".delete(")
});

// Discord's own toast factory. It builds the full internal payload the current
// toast renderer expects (variant, key, icon, duration, ...). Hand-rolling a
// { message, id, type, options } object results in an empty toast being shown.
const DiscordCreateToast = findByCodeLazy('variant:"default",icon:', ".duration");

export function createToast(message: string, type: string, options?: ToastOptions): ToastData {
    return {
        message,
        id: Toasts.genId(),
        type,
        options
    };
}

export const Toasts = {
    Type: ToastType,
    Position: ToastPosition,
    genId: () => (Math.random() || Math.random()).toString(36).slice(2),

    /**
     * Accepts our legacy ToastData shape and forwards it through Discord's
     * createToast so the payload matches what the current renderer expects.
     */
    show(data: ToastData) {
        ToastsExports.showToast(DiscordCreateToast({
            message: data.message,
            type: data.type,
            options: data.options
        }));
    },

    pop: ToastsExports.popToast,
    create: createToast,
};

/**
 * Legacy-compatible toast surface. Accepts the old ToastData shape and forwards
 * it through Discord's createToast so the payload matches the current renderer.
 */
export const Toasts = {
    Type: {
        MESSAGE: "message",
        SUCCESS: "success",
        FAILURE: "failure",
        CUSTOM: "custom",
        CLIP: "clip",
        LINK: "link",
        FORWARD: "forward",
        BOOKMARK: "bookmark",
        CLOCK: "clock"
    } as const,
    Position: {
        TOP: 0,
        BOTTOM: 1
    },
    genId: () => (Math.random() || Math.random()).toString(36).slice(2),

    show(data: t.ToastData & { id?: string } | t.NewToastData) {
        // If given our legacy shape, build Discord's internal payload through
        // its own createToast; NewToastData payloads are passed through as-is.
        if (data && (data as t.NewToastData).variant !== undefined) {
            ToastsExports.showToast(data as t.NewToastData);
        } else {
            const { id: _ignoredId, ...legacy } = data as t.ToastData & { id?: string };
            ToastsExports.showToast(createToast(legacy));
        }
    },

    pop: ToastsExports.popToast,

    create(message: string, type: string, options?: ToastOptions): ToastData {
        return { message, id: Toasts.genId(), type, options };
    }
};

/**
 * Show a simple toast. If you need more options, use Toasts.show manually
 */
export function showToast(message: string, type: t.ToastType = "message", options?: ToastOptions) {
    Toasts.show({ message, id: Toasts.genId(), type, options });
}

export const UserUtils = {
    getUser: findByCodeLazy(".USER(")
};

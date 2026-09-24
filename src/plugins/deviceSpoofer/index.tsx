/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

const logger = new Logger("DeviceSpoofer", "#a3e635");

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable device spoofing.",
        default: false,
        restartNeeded: false,
    },
    userAgent: {
        type: OptionType.STRING,
        description: "Spoofed User-Agent. Leave empty to keep the real one.",
        default: "",
        placeholder: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...",
    },
    platform: {
        type: OptionType.SELECT,
        description: "Spoofed navigator.platform (also overrides OS hints like navigator.os / client platform info).",
        options: [
            { label: "Keep real", value: "" },
            { label: "Windows", value: "Win32" },
            { label: "macOS (Intel)", value: "MacIntel" },
            { label: "macOS (Apple Silicon)", value: "MacARM64" },
            { label: "Linux x64", value: "Linux x86_64" },
            { label: "Android", value: "Linux armv8l" },
            { label: "iPhone", value: "iPhone" },
            { label: "iPad", value: "iPad" },
        ],
        default: "",
    },
    hardwareConcurrency: {
        type: OptionType.NUMBER,
        description: "Spoofed CPU core count (navigator.hardwareConcurrency). 0 = keep real.",
        default: 0,
    },
    deviceMemory: {
        type: OptionType.NUMBER,
        description: "Spoofed RAM in GiB (navigator.deviceMemory). 0 = keep real.",
        default: 0,
    },
    languages: {
        type: OptionType.STRING,
        description: "Spoofed languages as comma-separated tags (navigator.languages). Leave empty to keep real.",
        default: "",
        placeholder: "en-US,en",
    },
    timezone: {
        type: OptionType.STRING,
        description: "Spoofed IANA timezone for Intl APIs (e.g. Europe/Berlin). Leave empty to keep real.",
        default: "",
        placeholder: "Europe/Berlin",
    },
});

let applied: Array<() => void> = [];

function defineGetter(obj: any, prop: string, value: () => unknown) {
    const current = Object.getOwnPropertyDescriptor(obj, prop);
    if (current && !current.configurable) {
        logger.warn(`Cannot spoof ${prop}: property is not configurable`);
        return;
    }
    try {
        Object.defineProperty(obj, prop, {
            configurable: true,
            enumerable: current?.enumerable ?? true,
            get: () => value(),
        });
        applied.push(() => {
            try {
                delete obj[prop];
                if (current?.get) Object.defineProperty(obj, prop, current);
            } catch { /* best effort restore */ }
        });
    } catch (err) {
        logger.warn(`Failed to spoof ${prop}`, err);
    }
}

function patchIntl() {
    const tz = settings.store.timezone.trim();
    if (!tz) return;

    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const spoofed: any = function (...args: any[]) {
        const opts = args[1];
        if (opts && typeof opts === "object" && !("timeZone" in opts)) {
            opts.timeZone = tz;
        } else if (!opts) {
            args[1] = { timeZone: tz };
        }
        return new OriginalDateTimeFormat(...args);
    };
    spoofed.prototype = OriginalDateTimeFormat.prototype;
    spoofed.supportedLocalesOf = OriginalDateTimeFormat.supportedLocalesOf;

    const originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Object.defineProperty(Intl.DateTimeFormat.prototype, "resolvedOptions", {
        configurable: true,
        value() {
            const resolved = originalResolved.call(this);
            return { ...resolved, timeZone: tz };
        },
    });
    applied.push(() => {
        Object.defineProperty(Intl.DateTimeFormat.prototype, "resolvedOptions", {
            configurable: true,
            value: originalResolved,
        });
    });

    Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: spoofed });
    applied.push(() => {
        Object.defineProperty(Intl, "DateTimeFormat", { configurable: true, value: OriginalDateTimeFormat });
    });

    // Date.prototype.getTimezoneOffset: minutes behind UTC
    try {
        const fakeOffset = () => {
            const now = new Date();
            const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
            const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
            return (utc.getTime() - local.getTime()) / 60000;
        };
        const originalOffset = Date.prototype.getTimezoneOffset;
        Date.prototype.getTimezoneOffset = function () {
            return fakeOffset.call(this);
        };
        applied.push(() => { Date.prototype.getTimezoneOffset = originalOffset; });
    } catch (err) {
        logger.warn("Failed to spoof getTimezoneOffset", err);
    }
}

function applySpoof() {
    clearSpoof();
    if (!settings.store.enabled) return;

    const ua = settings.store.userAgent.trim();
    if (ua) {
        defineGetter(navigator, "userAgent", () => ua);
        if ("userAgentData" in navigator) {
            defineGetter(navigator, "userAgentData", () => undefined);
        }
    }

    const platform = settings.store.platform;
    if (platform) {
        defineGetter(navigator, "platform", () => platform);
        if ("userAgentData" in (navigator as any)) {
            const uad = (navigator as any).userAgentData;
            if (uad) defineGetter(uad, "platform", () => platformName(platform));
        }
    }

    const cores = settings.store.hardwareConcurrency;
    if (cores > 0) defineGetter(navigator, "hardwareConcurrency", () => cores);

    const mem = settings.store.deviceMemory;
    if (mem > 0) defineGetter(navigator, "deviceMemory", () => mem);

    const langs = settings.store.languages.trim();
    if (langs) {
        const list = langs.split(",").map(l => l.trim()).filter(Boolean);
        if (list.length) {
            defineGetter(navigator, "languages", () => list);
            defineGetter(navigator, "language", () => list[0]);
        }
    }

    patchIntl();
    logger.info("Device spoof applied");
}

function platformName(platform: string) {
    if (platform.startsWith("Win")) return "Windows";
    if (platform.startsWith("Mac")) return "macOS";
    if (platform.includes("armv") || platform === "iPhone" || platform === "iPad") return "Android";
    if (platform.startsWith("Linux")) return "Linux";
    return platform;
}

function clearSpoof() {
    for (const restore of applied) {
        try { restore(); } catch { /* ignore */ }
    }
    applied = [];
}

export default definePlugin({
    name: "Device Spoofer",
    description: "Spoofs your device fingerprint: user agent, platform, CPU cores, RAM, languages and timezone.",
    authors: [Devs.Vencipher],
    settings,

    start() {
        applySpoof();
    },

    stop() {
        clearSpoof();
        logger.info("Device spoof removed");
    },
});

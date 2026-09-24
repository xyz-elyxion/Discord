/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openModal } from "@utils/modal";
import { Modal } from "@webpack/common";
import { Logger } from "@utils/Logger";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, Forms, React, Toasts } from "@webpack/common";

const GITHUB_PAGE = "https://github.com/Vencipher/vencord-customplugins";
const PLUGIN_NAME = "FakeDeafen";
const PLUGIN_VERSION = 2.1;

const logger = new Logger(PLUGIN_NAME, "#7b68ee");
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const STYLE_ID = "fd-styles";
const CSS = `[class*="panels"] [class*="accountPopoutButtonWrapper"] { min-width: 0; }`;

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

function removeStyles() {
    document.getElementById(STYLE_ID)?.remove();
}

const settings = definePluginSettings({
    active: {
        type: OptionType.BOOLEAN,
        description: "Internal — master on/off switch, controlled by the button/keybind.",
        default: false,
        hidden: true,
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "While active, also fake mute (you can still speak locally).",
        default: false,
    },
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "While active, also fake deafen (you can still hear locally).",
        default: false,
    },
    fakeVideo: {
        type: OptionType.BOOLEAN,
        description: "While active, always report camera as on, even when it's really off.",
        default: false,
    },
    keybind: {
        type: OptionType.STRING,
        description: "Keyboard shortcut to toggle the master switch, e.g. \"ctrl+d\".",
        default: "ctrl+d",
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast notification when the master switch is toggled.",
        default: true,
    },
});

function UpdateModal({ to, modalProps }: { to: number; modalProps: any; }) {
    return (
        <Modal {...modalProps} title="Update Available">
            <Forms.FormText style={{ marginBottom: "8px" }}>
                <strong>{PLUGIN_NAME}</strong> — v{PLUGIN_VERSION} → v{to}
            </Forms.FormText>
            <Forms.FormText style={{ marginBottom: "8px" }}>
                Check the plugin GitHub page for the latest version.
            </Forms.FormText>
            <Forms.FormText>
                Plugin GitHub page:{" "}
                <a
                    href={GITHUB_PAGE}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: "var(--text-link)" }}
                    onClick={e => { e.preventDefault(); window.open(GITHUB_PAGE, "_blank", "noreferrer"); }}
                >
                    {GITHUB_PAGE}
                </a>
            </Forms.FormText>
            <Button color={Button.Colors.BRAND} onClick={modalProps.onClose}>Ok</Button>
        </Modal>
    );
}

async function checkForUpdates() {
    try {
        const res = await fetch(
            "https://raw.githubusercontent.com/Vencipher/vencord-customplugins/main/version.json",
            { cache: "no-store" }
        );
        if (!res.ok) {
            logger.warn(`Update check HTTP ${res.status}`);
            return;
        }
        const data: Record<string, number> = await res.json();
        const remote = data[PLUGIN_NAME] ?? 0;
        if (remote > PLUGIN_VERSION)
            openModal(mp => <UpdateModal to={remote} modalProps={mp} />);
    } catch (e) {
        logger.warn("Update check failed:", e);
    }
}

function IncognitoIcon() {
    const { active } = settings.use(["active"]);
    const fillColor = active ? "var(--status-danger, #f23f43)" : "currentColor";
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <defs>
                <mask id="fd-incognito-mask">
                    <rect width="24" height="24" fill="white" />
                    <rect x="8" y="8.2" width="8" height="1.8" rx="0.4" fill="black" />
                    <ellipse cx="9.5" cy="14" rx="2.2" ry="1.7" fill="black" />
                    <ellipse cx="14.5" cy="14" rx="2.2" ry="1.7" fill="black" />
                    <rect x="11.65" y="13.5" width="0.7" height="1" fill="white" />
                </mask>
            </defs>
            <g fill={fillColor} mask="url(#fd-incognito-mask)">
                <path d="M8.5 9.5 L9 4 Q12 2.8 15 4 L15.5 9.5 Z" />
                <ellipse cx="12" cy="9.5" rx="9.5" ry="2" />
                <circle cx="12" cy="14" r="4.5" />
                <path d="M3.5 23 Q3.5 18 8.5 17 L12 17.8 L15.5 17 Q20.5 18 20.5 23 Z" />
            </g>
        </svg>
    );
}

function showToast(active: boolean) {
    if (!settings.store.showToast) return;
    Toasts.show({
        message: active ? "FakeDeafen enabled" : "FakeDeafen disabled",
        id: Toasts.genId(),
        type: active ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
    });
}

function FakeDeafenButton(props: { nameplate?: any; }) {
    const { active, fakeMute, fakeDeafen, fakeVideo } = settings.use(["active", "fakeMute", "fakeDeafen", "fakeVideo"]);
    const prevRef = React.useRef({ fakeMute, fakeDeafen, fakeVideo });

    React.useEffect(() => {
        const prev = prevRef.current;
        const turnedOn =
            (fakeMute && !prev.fakeMute) ||
            (fakeDeafen && !prev.fakeDeafen) ||
            (fakeVideo && !prev.fakeVideo);
        if (turnedOn && !settings.store.active) {
            settings.store.active = true;
            showToast(true);
        }
        prevRef.current = { fakeMute, fakeDeafen, fakeVideo };
    }, [fakeMute, fakeDeafen, fakeVideo]);

    return (
        <PanelButton
            tooltipText={active ? "Disable FakeDeafen" : "Enable FakeDeafen"}
            icon={IncognitoIcon}
            role="switch"
            aria-checked={active}
            redGlow={active}
            plated={props?.nameplate != null}
            onClick={() => {
                const next = !active;
                settings.store.active = next;
                showToast(next);
            }}
        />
    );
}

interface ParsedKeybind {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
}

function parseKeybind(raw: string): ParsedKeybind | null {
    if (!raw || typeof raw !== "string") return null;
    const MODS = new Set(["ctrl", "shift", "alt"]);
    const parts = raw.toLowerCase().trim().split("+").map(p => p.trim()).filter(Boolean);
    const keys = parts.filter(p => !MODS.has(p));
    if (keys.length !== 1 || keys[0] === "") return null;
    return {
        key: keys[0],
        ctrl: parts.includes("ctrl"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt"),
    };
}

export default definePlugin({
    name: "FakeDeafen",
    description: "Appear muted, deafened, or streaming to others while your local audio is unaffected.",
    authors: [Devs.Vencipher],
    settings,
    enabledByDefault: true,

    _keyDownHandler: null as ((e: KeyboardEvent) => void) | null,

    patches: [
        {
            // Match any receiver/argument shape: .setSelfMute(<arg>) — robust
            // against Discord's changing minified variable names.
            find: "setSelfMute",
            replacement: [
                {
                    match: /\.setSelfMute\((\i+)\)/g,
                    replace: ".setSelfMute($self.settings.store.active&&$self.settings.store.fakeMute?false:$1)",
                },
                {
                    match: /\.setSelfDeaf\((\i+)\)/g,
                    replace: ".setSelfDeaf($self.settings.store.active&&$self.settings.store.fakeDeafen?false:$1)",
                },
            ],
        },
        {
            find: "self_video:",
            replacement: {
                match: /self_video:(\i+)/g,
                replace: "self_video:($self.settings.store.active&&$self.settings.store.fakeVideo?true:$1)",
            },
        },
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            noWarn: true,
            replacement: [
                {
                    match: /(?<=\.GameActivityToggleButton\(arguments\[0\]\),)/,
                    replace: "$self.FakeDeafenButton(arguments[0]),",
                },
                {
                    match: /children:\[(?![^,]{0,25}GameActivityToggleButton)(?=.{0,25}?accountContainerRef)/,
                    replace: "children:[$self.FakeDeafenButton(arguments[0]),",
                },
            ],
        },
    ],

    FakeDeafenButton: ErrorBoundary.wrap(FakeDeafenButton, { noop: true }),

    start() {
        injectStyles();
        checkForUpdates();
        this._keyDownHandler = (e: KeyboardEvent) => this._handleKeyDown(e);
        document.addEventListener("keydown", this._keyDownHandler);
    },

    stop() {
        removeStyles();
        if (this._keyDownHandler) {
            document.removeEventListener("keydown", this._keyDownHandler);
            this._keyDownHandler = null;
        }
    },

    _handleKeyDown(e: KeyboardEvent) {
        const parsed = parseKeybind(settings.store.keybind);
        if (!parsed) return;
        if (
            e.key.toLowerCase() === parsed.key &&
            e.ctrlKey === parsed.ctrl &&
            e.shiftKey === parsed.shift &&
            e.altKey === parsed.alt
        ) {
            e.preventDefault();
            this._toggleAll();
        }
    },

    _toggleAll() {
        const next = !settings.store.active;
        settings.store.active = next;
        showToast(next);
    },
});

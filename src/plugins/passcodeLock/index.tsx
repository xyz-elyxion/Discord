/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Converted from the BetterDiscord plugin "PasscodeLock" by arg0NNY
 * (https://github.com/okdevme/DiscordPlugins) — re-implemented natively
 * for Limey V1.
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Button, TextInput, Toasts, showToast, useEffect, useState, useRef, React, createRoot } from "@webpack/common";

type CodeType = "4-digit" | "6-digit" | "custom-numeric";

interface CodeHash {
    hash: string;
    salt: string;
    iterations: number;
}

// --- PBKDF2 hashing (same scheme as the original) ---------------------------

const b64binb = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const str2binb = (str: string) => new TextEncoder().encode(str);
const buf2hex = (buffer: ArrayBuffer) =>
    Array.from(new Uint8Array(buffer), x => x.toString(16).padStart(2, "0")).join("");

async function pbkdf2(string: string, saltHex: string, iterations: number) {
    const key = await crypto.subtle.importKey("raw", str2binb(string), { name: "PBKDF2" }, false, ["deriveKey"]);
    const derived = await crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: hex2binb(saltHex),
            iterations,
            hash: { name: "SHA-1" }
        },
        key,
        { name: "HMAC", hash: "SHA-1", length: 160 },
        true,
        ["sign"]
    );
    const raw = await crypto.subtle.exportKey("raw", derived);
    return buf2hex(raw);
}

function hex2binb(hex: string) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

async function hashCode(code: string): Promise<CodeHash> {
    const salt = buf2hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const iterations = 4000;
    return { hash: await pbkdf2(code, salt, iterations), salt, iterations };
}

async function hashCheck(code: string, stored: CodeHash) {
    return (await pbkdf2(code, stored.salt, stored.iterations)) === stored.hash;
}

// --- Settings ----------------------------------------------------------------

const codeLength = () => {
    switch (settings.store.codeType as CodeType) {
        case "4-digit": return 4;
        case "6-digit": return 6;
        default: return -1;
    }
};

const settings = definePluginSettings({
    codeType: {
        description: "Code type",
        type: OptionType.SELECT,
        options: [
            { label: "4-Digit Numeric Code", value: "4-digit", default: true },
            { label: "6-Digit Numeric Code", value: "6-digit" },
            { label: "Custom Numeric Code", value: "custom-numeric" },
        ],
        onChange() {
            // Changing the code type invalidates the stored passcode
            settings.store.hash = "";
            showToast("Your passcode has been reset. Set it up again.", Toasts.Type.FAILURE);
        }
    },
    lockKeybind: {
        description: "Key combination that locks Discord (e.g. control+l)",
        type: OptionType.STRING,
        default: "control+l"
    },
    autolock: {
        description: "Auto-lock after inactivity (seconds, 0 = disabled)",
        type: OptionType.NUMBER,
        default: 0
    },
    lockOnStartup: {
        description: "Always lock on startup",
        type: OptionType.BOOLEAN,
        default: false
    },
    hideNotifications: {
        description: "Censor notifications while locked",
        type: OptionType.BOOLEAN,
        default: false
    },
    // Internal — not shown to the user. The passcode is stored as a
    // PBKDF2 hash with a random salt so the code itself is never saved.
    hash: { type: OptionType.STRING, default: "", hidden: true },
    salt: { type: OptionType.STRING, default: "", hidden: true },
    iterations: { type: OptionType.NUMBER, default: 4000, hidden: true },
    locked: { type: OptionType.BOOLEAN, default: false, hidden: true },
    attempts: { type: OptionType.NUMBER, default: 0, hidden: true },
    delayUntil: { type: OptionType.NUMBER, default: 0, hidden: true }
} as any);

const hasPasscode = () => !!settings.store.hash;

// --- CSS ---------------------------------------------------------------------

const css = `
.v1-pcl-layout {
    position: fixed;
    inset: 0;
    z-index: 2999;
    overflow: hidden;
    color: #dcddde;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, .5);
    backdrop-filter: blur(30px);
    user-select: none;
}
.v1-pcl-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-bottom: 22px;
}
.v1-pcl-title {
    margin: 25px 0;
    font-size: 20px;
    font-weight: 600;
}
.v1-pcl-dots {
    display: flex;
    height: 8px;
    justify-content: center;
}
.v1-pcl-dot {
    height: 8px;
    width: 8px;
    border-radius: 50%;
    margin: 0 5px;
    opacity: 0;
    transform: scale(.5);
    transition: .25s opacity, .25s transform;
    background: #dcddde;
}
.v1-pcl-dot.v1-pcl-dot-active {
    opacity: 1;
    transform: scale(1);
}
.v1-pcl-buttons {
    display: grid;
    grid-template-columns: repeat(3, 64px);
    grid-auto-rows: 64px;
    gap: 24px;
    padding: 40px 20px;
}
.v1-pcl-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 50%;
    border: 1px solid transparent;
    transition: .3s background-color;
}
.v1-pcl-btn:hover {
    border-color: rgba(255, 255, 255, .15);
    background-color: rgba(255, 255, 255, .1);
}
.v1-pcl-btn-number {
    font-size: 32px;
    font-weight: 500;
    line-height: 36px;
}
.v1-pcl-btn-dec {
    height: 11px;
    font-size: 10px;
    text-transform: uppercase;
    color: rgba(255, 255, 255, .3);
}
.v1-pcl-delay {
    position: absolute;
    top: 55px;
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    text-align: center;
    line-height: 1.2;
}
`;

// --- Lock screen component ----------------------------------------------------

const MAX_CODE_LENGTH = 15;

function PasscodeLocker({ mode, onUnlock, onCancel }: {
    mode: "default" | "editor";
    onUnlock: (newCode?: string) => void;
    onCancel: () => void;
}) {
    const [code, setCode] = useState("");
    const [confirm, setConfirm] = useState(false);
    const [delayLeft, setDelayLeft] = useState(0);
    const newCode = useRef<string | null>(null);

    const len = codeLength();

    const handleDelay = () => {
        const left = Math.ceil((settings.store.delayUntil - Date.now()) / 1000);
        setDelayLeft(Math.max(0, left));
    };

    useEffect(() => {
        handleDelay();
        const interval = setInterval(handleDelay, 1000);

        const onKey = (e: KeyboardEvent) => {
            if (delayLeft > 0) return;
            if (!isNaN(+e.key) && e.key !== " ") append(+e.key);
            else if (e.key === "Backspace") setCode(c => c.slice(0, -1));
            else if (e.key === "Enter") accept();
            else if (e.key === "Escape") onCancel();
        };
        window.addEventListener("keyup", onKey);
        return () => {
            clearInterval(interval);
            window.removeEventListener("keyup", onKey);
        };
    }, [delayLeft, code]);

    async function submit() {
        if (mode === "editor") {
            if (!confirm) {
                newCode.current = code;
                setCode("");
                setConfirm(true);
            } else if (code === newCode.current) {
                onUnlock(newCode.current!);
            } else {
                fail();
            }
            return;
        }

        if (await hashCheck(code, {
            hash: settings.store.hash,
            salt: settings.store.salt,
            iterations: settings.store.iterations
        })) {
            settings.store.attempts = 0;
            settings.store.delayUntil = 0;
            onUnlock();
        } else {
            fail();
        }
    }

    function fail() {
        setCode("");
        if (mode !== "default") return;

        const attempts = (settings.store.attempts ?? 0) + 1;
        settings.store.attempts = attempts;
        if (attempts >= 3) {
            settings.store.delayUntil = Date.now() + Math.min(30000, 5000 * (attempts - 2));
            handleDelay();
        }
    }

    function append(num: number) {
        if (code.length >= MAX_CODE_LENGTH) return;
        const next = code + num.toString();
        setCode(next);
        if (len !== -1 && len <= next.length) setTimeout(() => submitRef.current?.(), 0);
    }

    // keep submit accessible from the auto-submit timeout
    const submitRef = useRef<() => void>(submit);
    submitRef.current = submit;

    function accept() {
        if (code === "") return;
        submit();
    }

    const btns = ["ABC", "DEF", "GHI", "JKL", "MNO", "PQRS", "TUV", "WXYZ"];

    return (
        <div className="v1-pcl-layout">
            <div style={{ position: "relative" }}>
                <div className="v1-pcl-header">
                    <div className="v1-pcl-title">
                        {mode === "editor"
                            ? (!confirm ? "Enter your new passcode" : "Re-enter your passcode")
                            : "Enter your Discord passcode"}
                    </div>
                    <div className="v1-pcl-dots">
                        {Array(MAX_CODE_LENGTH).fill(null).map((_, i) => (
                            <div key={i} className={"v1-pcl-dot" + (i < code.length ? " v1-pcl-dot-active" : "")} />
                        ))}
                    </div>
                </div>
                {delayLeft > 0 && (
                    <div className="v1-pcl-delay">
                        Too many tries.
                        {"\n"}Please try again in {delayLeft} {delayLeft > 1 ? "seconds" : "second"}.
                    </div>
                )}
                <div className="v1-pcl-buttons">
                    {btns.map((dec, i) => (
                        <div key={i} className="v1-pcl-btn" onClick={() => append(i + 1)}>
                            <div className="v1-pcl-btn-number">{i + 1}</div>
                            <div className="v1-pcl-btn-dec">{dec}</div>
                        </div>
                    ))}
                    <div className="v1-pcl-btn" onClick={onCancel}>⏎</div>
                    <div className="v1-pcl-btn" onClick={() => append(0)}>
                        <div className="v1-pcl-btn-number">0</div>
                        <div className="v1-pcl-btn-dec">+</div>
                    </div>
                    <div className="v1-pcl-btn" onClick={() => setCode(c => c.slice(0, -1))}>⌫</div>
                </div>
            </div>
        </div>
    );
}

// --- Plugin --------------------------------------------------------------------

const V1Plugin = {
    name: "PasscodeLock",
    description: "Protect your Discord with a passcode. Converted from the BetterDiscord plugin by arg0NNY.",
    tags: ["Utility", "Privacy"],
    authors: [Devs.Limey],
    settings,

    managedStyle: css,

    toolboxActions: {
        "Lock Discord": function (this: any) { this.lock(); }
    },

    settingsAboutComponent: () => {
        const [has, setHas] = useState(hasPasscode());
        return (
            <Button
                onClick={() => (V1Plugin as any).lock(has ? "default" : "editor")}
            >
                {has ? "Change Passcode" : "Set Passcode"}
            </Button>
        );
    },

    locked: false,
    lockRoot: null as HTMLDivElement | null,
    keyHandler: null as ((e: KeyboardEvent) => void) | null,
    keybindHandler: null as ((e: KeyboardEvent) => void) | null,
    blurListener: null as (() => void) | null,
    focusListener: null as (() => void) | null,
    autolockTimeout: undefined as ReturnType<typeof setTimeout> | undefined,

    lock(mode: "default" | "editor" = "default") {
        // Clean up any stale lock state from a previous failed attempt
        if (this.locked) this.unlock();
        if (!hasPasscode() && mode === "default") {
            return void showToast("Please first set up the passcode in the plugin settings.", Toasts.Type.FAILURE);
        }

        this.locked = true;
        settings.store.locked = true;

        const close = () => this.unlock();

        this.lockRoot = document.createElement("div");
        document.body.appendChild(this.lockRoot);
        const container = this.lockRoot;
        {
            const root = createRoot(container);
            const Locker = PasscodeLocker as any;
            root.render(
                React.createElement(Locker, {
                    mode,
                    onUnlock: (code?: string) => {
                        if (code) {
                            hashCode(code).then(async hashed => {
                                settings.store.hash = hashed.hash;
                                settings.store.salt = hashed.salt;
                                settings.store.iterations = hashed.iterations;
                                showToast("Passcode has been updated!", Toasts.Type.SUCCESS);
                            });
                        }
                        close();
                    },
                    onCancel: () => close()
                })
            );
        }

        // Block Ctrl+Shift+I / C and other shortcuts while locked
        this.keyHandler = e => {
            if (e.ctrlKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", this.keyHandler, true);
    },

    unlock() {
        this.locked = false;
        settings.store.locked = false;
        settings.store.attempts = 0;
        settings.store.delayUntil = 0;

        if (this.lockRoot) {
            const root = this.lockRoot;
            this.lockRoot = null;
            root.remove();
        }
        if (this.keyHandler) {
            window.removeEventListener("keydown", this.keyHandler, true);
            this.keyHandler = null;
        }
    },

    start() {
        const kb = (settings.store.lockKeybind || "control+l").toLowerCase().split("+");

        this.keybindHandler = (e: KeyboardEvent) => {
            const pressed = [
                e.ctrlKey && "control",
                e.shiftKey && "shift",
                e.altKey && "alt",
                e.metaKey && "meta",
                e.key.toLowerCase()
            ].filter(Boolean);
            if (kb.every(k => pressed.includes(k)) && pressed.length === kb.length) this.lock();
        };
        window.addEventListener("keydown", this.keybindHandler);

        this.blurListener = () => {
            const autolock = settings.store.autolock;
            if (!autolock) return;
            this.autolockTimeout = setTimeout(() => this.lock(), autolock * 1000);
        };
        this.focusListener = () => clearTimeout(this.autolockTimeout);
        window.addEventListener("blur", this.blurListener);
        window.addEventListener("focus", this.focusListener);

        if (hasPasscode() && (settings.store.lockOnStartup || settings.store.locked)) setTimeout(() => this.lock());
    },

    stop() {
        this.unlock();
        if (this.keybindHandler) window.removeEventListener("keydown", this.keybindHandler);
        clearTimeout(this.autolockTimeout);
        window.removeEventListener("blur", this.blurListener!);
        window.removeEventListener("focus", this.focusListener!);
    }
};

export default definePlugin(V1Plugin as any);

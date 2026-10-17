/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";

const logger = new Logger("AntiScam/SecurityKey");

/**
 * Security key registry for Anti-Scam's destructive-account actions
 * ("log out all devices" in particular).
 *
 * Because logging out every device is a 2FA-class action, the user has to set
 * up a **V1 passkey** first: a real WebAuthn credential whose Relying Party id
 * is the origin the client runs on. When V1 is running in the Discord web app
 * that origin is discord.com, so the passkey genuinely lives on the
 * "discord.com" WebAuthn identity — "V1's own passkey connected to Discord".
 * The private key never leaves the authenticator; the plugin only stores the
 * credential id, and every destructive call is gated behind a user-verified
 * assertion, exactly like a 2FA prompt.
 */

const SECURITY_KEY_STORE = "AntiScamV1:securityKey";

export interface StoredSecurityKey {
    /** Discord user id the key was minted for */
    userId: string;
    username: string;
    /** base64url encoding of the credential's raw id */
    credentialId: string;
    /** WebAuthn Relying Party id the key was minted under (location.hostname) */
    rpId: string;
    createdAt: number;
}

const COSE_ALG_ES256 = -7;
const COSE_ALG_ED25519 = -257;

function bytesToBase64url(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function isWebAuthnSupported(): boolean {
    return typeof PublicKeyCredential !== "undefined"
        && typeof navigator?.credentials?.create === "function"
        && typeof navigator?.credentials?.get === "function";
}

/** Read the locally stored passkey record, if one exists. */
export async function getStoredSecurityKey(): Promise<StoredSecurityKey | null> {
    try {
        const stored = await DataStore.get<StoredSecurityKey>(SECURITY_KEY_STORE);
        return stored ?? null;
    } catch (e) {
        logger.warn("failed to read security key record", e);
        return null;
    }
}

export async function isSecurityKeySetUp(): Promise<boolean> {
    return (await getStoredSecurityKey()) !== null;
}

/**
 * Mint a new V1 passkey through the platform authenticator and record its
 * credential id locally. Must be called from a real user interaction
 * (the settings button click supplies that).
 */
export async function setUpSecurityKey(user: { id: string; username: string; displayName?: string; }): Promise<StoredSecurityKey> {
    if (!isWebAuthnSupported()) {
        throw new Error("WebAuthn is not available here — security keys need a browser or desktop client that supports passkeys.");
    }

    // Hash the user id so the authenticator never sees the raw Discord id and
    // its length is a fixed 32 bytes (raw user ids can exceed the 64-byte cap).
    const userIdDigest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(user.id)),
    );

    const challenge = crypto.getRandomValues(new Uint8Array(32));

    const credential = await navigator.credentials.create({
        publicKey: {
            challenge,
            rp: {
                id: globalThis.location.hostname,
                name: "Limey V1"
            },
            user: {
                id: userIdDigest,
                name: `${user.username}.v1.annotate`,
                displayName: user.displayName ?? "Limey V1 — Anti-Scam security key"
            },
            pubKeyCredParams: [
                { type: "public-key", alg: COSE_ALG_ES256 },
                { type: "public-key", alg: COSE_ALG_ED25519 }
            ],
            authenticatorSelection: {
                // "required" is the core of the 2FA-like gate: every assertion
                // has to go through a real fingerprint / PIN / unlock step.
                userVerification: "required"
            },
            timeout: 120_000,
            attestation: "none",
        },
    }).catch((e: unknown) => {
        // Give NotAllowedError / timeout the human-readable explanation the
        // browser error alone lacks.
        if (e instanceof DOMException && e.name === "NotAllowedError") {
            throw new Error(
                "The passkey prompt was cancelled, timed out or blocked by the browser. "
                + "Click the button again and complete the authenticator prompt "
                + "(fingerprint / PIN / security key / Windows Hello).",
            );
        }
        throw e;
    }) as PublicKeyCredential | null;

    if (!credential) throw new Error("The authenticator did not return a security key.");

    const stored: StoredSecurityKey = {
        userId: user.id,
        username: user.username,
        credentialId: bytesToBase64url(new Uint8Array(credential.rawId as ArrayBuffer)),
        rpId: globalThis.location.hostname,
        createdAt: Date.now(),
    };
    await DataStore.set(SECURITY_KEY_STORE, stored);
    return stored;
}

/** Remove the stored V1 passkey record (the authenticator state is untouched). */
export async function removeSecurityKey(): Promise<void> {
    await DataStore.del(SECURITY_KEY_STORE);
}

async function requestSecurityKeyAssertion(): Promise<PublicKeyCredential | null> {
    if (!isWebAuthnSupported()) {
        throw new Error("WebAuthn is not available in this environment.");
    }
    const stored = await getStoredSecurityKey();
    if (!stored) {
        throw new Error("No V1 security key is set up for this account yet — set one up in the Anti-Scam settings first.");
    }
    if (stored.rpId !== globalThis.location.hostname) {
        throw new Error(`This V1 security key was made on ${stored.rpId}, so it cannot be used from ${globalThis.location.hostname}.`);
    }

    const challenge = crypto.getRandomValues(new Uint8Array(32));
    return navigator.credentials.get({
        publicKey: {
            challenge,
            rpId: stored.rpId,
            allowCredentials: [{
                type: "public-key",
                id: base64urlToBytes(stored.credentialId),
            }],
            userVerification: "required",
            timeout: 60_000,
        },
    }) as Promise<PublicKeyCredential | null>;
}

/**
 * Require the registered V1 passkey before a destructive action runs.
 * Resolves when a user-verified WebAuthn assertion came back, throws
 * otherwise. This is the "2FA prompt" equivalent for plugin-driven account
 * actions.
 */
export async function requireSecurityKey(): Promise<void> {
    const assertion = await requestSecurityKeyAssertion();

    if (!assertion || !assertion.response) {
        throw new Error("V1 security key challenge failed: no authenticator assertion was returned.");
    }
    const clientData = JSON.parse(
        new TextDecoder().decode(assertion.response.clientDataJSON),
    ) as { type?: string; origin?: string; userVerification?: string; };
    if (clientData.type !== "webauthn.get") {
        throw new Error("V1 security key challenge failed: wrong WebAuthn ceremony type.");
    }
    if (clientData.origin !== globalThis.location.origin) {
        throw new Error("V1 security key challenge failed: assertion came from an unexpected origin.");
    }
}

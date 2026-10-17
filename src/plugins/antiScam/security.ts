/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { RestAPI } from "@webpack/common";

const logger = new Logger("AntiScam/SecurityKey");

/**
 * Discord two-factor layer for Anti-Scam's destructive-account actions.
 *
 * "Log out all other devices" is an MFA-required action: Discord first rejects
 * it with error code 60003 and hands out `body.mfa.ticket` plus a list of the
 * available verification methods. One of those methods is `webauthn` — a
 * *security key registered with Discord itself* (relying-party id
 * `discord.com`), not a locally-minted certificate. The flow used here:
 *
 *   1. Run the protected request -> reject 60003 { mfa: { ticket, methods } }
 *   2. navigator.credentials.get() with the challenge from the webauthn
 *      method -> the user touches their Discord security key
 *   3. POST /mfa/finish { ticket, mfa_type: "webauthn", data: <CredentialJSON> }
 *      -> { token }
 *   4. Retry the original request with
 *      X-Discord-MFA-Authorization: <token>
 *
 * V1 therefore never fakes 2FA: the key that answers is the one Discord
 * itself enrolled, and Discord verifies the assertion server-side.
 */

const LEGACY_KEY_STORE = "AntiScamV1:securityKey";
/** Credential-creation/verification endpoint (MFA WebAuthn registry). */
const WEBAUTHN_CREDENTIALS_ROUTE = "/users/@me/mfa/webauthn/credentials";
/** Code Discord returns for "two factor required for this operation". */
export const MFA_REQUIRED = 60003;

/* ------------------------------------------------------------------------- */
/* base64url helpers                                                         */
/* ------------------------------------------------------------------------- */

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

function bufferToBase64url(value: ArrayBuffer | null): string | null {
    return value ? bytesToBase64url(new Uint8Array(value)) : null;
}

export function isWebAuthnSupported(): boolean {
    return typeof PublicKeyCredential !== "undefined"
        && typeof navigator?.credentials?.create === "function"
        && typeof navigator?.credentials?.get === "function";
}

function friendlyApiError(e: any, fallback: string): Error {
    const message = e?.body?.message ?? e?.message ?? String(e);
    const code = e?.body?.code;
    return new Error(code != null ? `${fallback} (${message}, code ${code})` : `${fallback} (${message})`);
}

/* ------------------------------------------------------------------------- */
/* Where Discord keeps its registered security keys                          */
/* ------------------------------------------------------------------------- */

interface WebauthnStatus {
    /** Number of webauthn credentials enrolled with the Discord account. */
    count: number | null;
}

/**
 * Ask the account how many WebAuthn security keys are enrolled. Tolerates the
 * two response shapes in the wild (`webauthn: { credentials: [...] }` vs a
 * flat credential list) and returns `null` when the endpoints answer in a
 * shape we do not recognise, so callers can fall back instead of fake-failing.
 */
export async function getDiscordWebauthnStatus(): Promise<WebauthnStatus> {
    try {
        const res = await RestAPI.get({ url: "/users/@me/mfa/methods" }) as any;
        const body = res?.body ?? {};
        const { webauthn } = body;
        if (Array.isArray(webauthn?.credentials)) return { count: webauthn.credentials.length };
        if (Array.isArray(webauthn)) return { count: webauthn.length };
        if (typeof webauthn?.enabled === "boolean") return { count: webauthn.enabled ? 1 : 0 };
        // Flat client settings shape: { totp: bool, security_keys: bool, ... }
        if (typeof body.security_keys === "boolean") return { count: body.security_keys ? 1 : 0 };
        if (Array.isArray(body.authenticator_types)) {
            // authenticator_types enum: 1 = WEBAUTHN, 2 = TOTP, 3 = SMS (per
            // Discord's user objects) — never treat TOTP/SMS as a key.
            return { count: body.authenticator_types.includes(1) ? 1 : 0 };
        }
        return { count: null };
    } catch (primaryErr: any) {
        // Some builds only expose the credential collection directly.
        try {
            const res = await RestAPI.get({ url: WEBAUTHN_CREDENTIALS_ROUTE }) as any;
            const body = res?.body;
            if (Array.isArray(body)) return { count: body.length };
            if (Array.isArray(body?.credentials)) return { count: body.credentials.length };
            return { count: null };
        } catch (secondaryErr) {
            logger.warn("could not read Discord webauthn status", primaryErr, secondaryErr);
            return { count: null };
        }
    }
}

/**
 * Whether this Discord account already carries at least one security key
 * Discord can challenge for MFA. This is answered by Discord itself; a
 * locally stored record never counts — the plugin no longer mints keys, so
 * any leftover local entry is just stale data and is cleared on sight.
 */
export async function isSecurityKeySetUp(): Promise<boolean> {
    const { count } = await getDiscordWebauthnStatus();
    if (count == null) {
        // Purge any leftover pre-Discord-flow local record so it can never
        // make the UI claim a passkey the account doesn't have.
        void DataStore.del(LEGACY_KEY_STORE).catch(() => null);
        return false;
    }
    return count > 0;
}

/* ------------------------------------------------------------------------- */
/* Completing a Discord MFA challenge with the registered security key        */
/* ------------------------------------------------------------------------- */

interface WebauthnMethod {
    type?: string;
    /** Stringified JSON request options, per Discord's mfa methods payload. */
    challenge?: string;
}

function parseChallenge(raw: string): PublicKeyCredentialRequestOptions {
    const parsed = JSON.parse(raw) as any;
    const options = parsed?.publicKey && typeof parsed.publicKey === "object" ? parsed.publicKey : parsed;
    if (typeof options?.challenge !== "string") {
        throw new Error("Discord's security-key challenge could not be parsed.");
    }
    return {
        challenge: base64urlToBytes(options.challenge),
        rpId: typeof options.rpId === "string" ? options.rpId : "discord.com",
        timeout: typeof options.timeout === "number" ? options.timeout : 120_000,
        userVerification: options.userVerification ?? "required",
        allowCredentials: Array.isArray(options.allowCredentials)
            ? options.allowCredentials.map((cred: any) => ({
                type: typeof cred?.type === "string" ? cred.type : "public-key",
                id: base64urlToBytes(cred.id),
            }))
            : [],
    };
}

/**
 * Given the 60003 rejection of a protected request, complete the webauthn
 * challenge with the user's Discord-registered security key and return the
 * `X-Discord-MFA-Authorization` token from `/mfa/finish`.
 */
export async function completeWebauthnMfa(error: any): Promise<string> {
    if (!isWebAuthnSupported()) {
        throw new Error("This client has no WebAuthn support, so V1 cannot answer Discord's security-key challenge.");
    }

    const body = error?.body ?? error;
    if (body?.code !== MFA_REQUIRED) {
        throw friendlyApiError(error, "Discord rejected the session logout");
    }
    const ticket = body?.mfa?.ticket;
    if (typeof ticket !== "string" || !ticket) {
        throw new Error("Discord requires two-factor for this action, but the response carried no MFA ticket.");
    }
    const webauthn = (body?.mfa?.methods as WebauthnMethod[] | undefined)
        ?.find(m => m?.type === "webauthn" && typeof m.challenge === "string");
    if (!webauthn) {
        const available = (body?.mfa?.methods as any[] | undefined)?.map(m => m?.type).filter(Boolean).join(", ");
        throw new Error(
            "Two-factor is required, but this account has no security key (webauthn) enrolled with Discord"
            + (available ? ` — Discord only offers: ${available}` : "")
            + ". Enrol one in Discord's settings or press 'Setup security key with Discord' in Anti-Scam settings first.",
        );
    }

    let assertion: PublicKeyCredential | null;
    try {
        assertion = await navigator.credentials.get({
            publicKey: parseChallenge(webauthn.challenge!),
        }) as PublicKeyCredential | null;
    } catch (e) {
        throw new Error(
            "The security-key prompt was cancelled, timed out or blocked. Click the button again and complete the prompt with your Discord security key.",
        );
    }
    if (!assertion?.response) throw new Error("No authenticator assertion came back; the security-key prompt was not completed.");

    const { response } = assertion;
    const credentialJson = JSON.stringify({
        id: assertion.id,
        rawId: bufferToBase64url(assertion.rawId as ArrayBuffer),
        type: assertion.type,
        response: {
            authenticatorData: bufferToBase64url((response as any).authenticatorData ?? null),
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            signature: bufferToBase64url((response as any).signature ?? null),
            userHandle: bufferToBase64url((response as any).userHandle ?? null),
        },
    });

    let finish: any;
    try {
        finish = await RestAPI.post({
            url: "/mfa/finish",
            body: { ticket, mfa_type: "webauthn", data: credentialJson },
        }) as any;
    } catch (e) {
        throw friendlyApiError(e, "Discord refused the security-key assertion");
    }
    const token = finish?.body?.token ?? (finish as any)?.token;
    if (typeof token !== "string" || !token) {
        throw new Error("Discord did not return an MFA token after the security-key verification.");
    }
    return token;
}

/* ------------------------------------------------------------------------- */
/* Enrolling a security key WITH Discord                                     */
/* ------------------------------------------------------------------------- */

/**
 * Register a new WebAuthn security key on the Discord account (rpId
 * `discord.com`), so it — not a locally minted key — is what later MFA
 * prompts run against. Enrolling credentials is itself an MFA-protected
 * action, so the flow reuses completeWebauthnMfa when Discord demands 2FA.
 */
export async function setUpSecurityKey(name = "Limey V1"): Promise<void> {
    if (!isWebAuthnSupported()) {
        throw new Error("WebAuthn is not available in this environment — use a browser or desktop client that supports security keys.");
    }

    const attempt = (headers?: Record<string, string>) => RestAPI.post({
        url: WEBAUTHN_CREDENTIALS_ROUTE,
        body: { name },
        headers,
    } as any) as any;

    let res: any;
    try {
        res = await attempt();
    } catch (firstError: any) {
        if (firstError?.body?.code !== MFA_REQUIRED) {
            throw friendlyApiError(firstError, "Discord refused to start security-key enrolment");
        }
        // Protected action: verify with an already-enrolled method first.
        const token = await completeWebauthnMfa(firstError);
        try {
            res = await attempt({ "X-Discord-MFA-Authorization": token } as any);
        } catch (secondError) {
            throw friendlyApiError(secondError, "Discord refused security-key enrolment even after verification");
        }
    }

    // Some enrolment responses hand the registration challenge instead of
    // instant-creating; run the WebAuthn ceremony and finish it up.
    const challengeStr = res?.body?.challenge;
    if (typeof challengeStr === "string" && challengeStr) {
        const parsed = JSON.parse(challengeStr) as any;
        const options = parsed?.publicKey && typeof parsed.publicKey === "object" ? parsed.publicKey : parsed;
        let credential: PublicKeyCredential | null;
        try {
            credential = await navigator.credentials.create({
                publicKey: {
                    challenge: base64urlToBytes(options.challenge),
                    rp: { id: options.rpId ?? "discord.com", name: "Discord" },
                    user: {
                        id: base64urlToBytes(options.user?.id ?? ""),
                        name: options.user?.name ?? "discord",
                        displayName: options.user?.displayName ?? "Discord security key",
                    },
                    pubKeyCredParams: Array.isArray(options.pubKeyCredParams) && options.pubKeyCredParams.length
                        ? options.pubKeyCredParams
                        : [{ type: "public-key", alg: -7 }],
                    authenticatorSelection: options.authenticatorSelection ?? { userVerification: "required" },
                    timeout: typeof options.timeout === "number" ? options.timeout : 120_000,
                    attestation: options.attestation ?? "none",
                    excludeCredentials: Array.isArray(options.excludeCredentials)
                        ? options.excludeCredentials.map((c: any) => ({
                            type: c.type ?? "public-key",
                            id: base64urlToBytes(c.id),
                        }))
                        : [],
                },
            }) as PublicKeyCredential | null;
        } catch {
            throw new Error("The security-key prompt was cancelled or timed out — try again and complete the prompt.");
        }
        if (!credential) throw new Error("No authenticator credential came back; the prompt was not completed.");

        try {
            await RestAPI.post({
                url: WEBAUTHN_CREDENTIALS_ROUTE,
                body: {
                    name,
                    credential: JSON.stringify({
                        id: credential.id,
                        rawId: bufferToBase64url(credential.rawId as ArrayBuffer),
                        type: credential.type,
                        response: {
                            attestationObject: bufferToBase64url((credential.response as any).attestationObject ?? null),
                            clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
                        },
                    }),
                },
            }) as any;
        } catch (finalError) {
            throw friendlyApiError(finalError, "Discord refused the new security key credential");
        }
    }
    // Clean up the pre-Discord-flow local record so the legacy fallback never
    // claims a passkey that doesn't exist on the account anymore.
    void DataStore.del(LEGACY_KEY_STORE).catch(() => null);
}

/** List the WebAuthn credentials registered with this Discord account. */
async function fetchWebauthnCredentials(): Promise<any[]> {
    try {
        const res = await RestAPI.get({ url: WEBAUTHN_CREDENTIALS_ROUTE }) as any;
        const body = res?.body;
        if (Array.isArray(body)) return body;
        if (Array.isArray(body?.credentials)) return body.credentials;
    } catch (e) {
        logger.warn("could not list Discord webauthn credentials", e);
    }
    throw new Error("Discord's security-key list came back in an unexpected shape.");
}

/**
 * Full picture of the account's security-key situation:
 * - `anyKey`: a security key Discord can challenge for MFA exists at all;
 * - `v1Enrolled`: whether at least one of those was enrolled by V1 itself
 *   (matched by the name V1 sets). `null` when Discord's credential list
 *   could not be read in a shape we recognise.
 */
export interface SecurityKeyState {
    anyKey: boolean;
    v1Enrolled: boolean | null;
}

export async function getSecurityKeyState(name = "Limey V1"): Promise<SecurityKeyState> {
    if (!(await isSecurityKeySetUp())) return { anyKey: false, v1Enrolled: false };
    try {
        const credentials = await fetchWebauthnCredentials();
        return {
            anyKey: true,
            v1Enrolled: credentials.some(
                c => typeof c?.name === "string" && c.name.toLowerCase().includes(name.toLowerCase()),
            ),
        };
    } catch {
        // Key exists but the list is unreadable — removal can't be proven.
        return { anyKey: true, v1Enrolled: null };
    }
}

/**
 * Remove the security key(s) V1 enrolled (via the real deletion endpoint
 * `DELETE /users/@me/mfa/webauthn/credentials/{id}`), plus any leftover local
 * record. Keys you enrolled yourself through Discord's settings are left
 * alone — V1 cannot tell those apart from anything else it didn't create.
 */
export async function removeSecurityKey(name = "Limey V1"): Promise<void> {
    await DataStore.del(LEGACY_KEY_STORE).catch(() => null);

    const credentials = await fetchWebauthnCredentials();
    const mine = credentials.filter(
        c => typeof c?.name === "string" && c.name.toLowerCase().includes(name.toLowerCase()),
    );
    if (mine.length === 0) {
        throw new Error(
            "No Limey V1-enrolled key was found on this Discord account, so there is nothing for V1 to remove. "
            + "Keys registered outside V1 are managed in User Settings → My Account.",
        );
    }

    const attempt = (credId: string, headers?: Record<string, string>) => RestAPI.del({
        url: `${WEBAUTHN_CREDENTIALS_ROUTE}/${encodeURIComponent(credId)}`,
        headers,
    } as any) as any;

    for (const cred of mine) {
        try {
            await attempt(cred.id);
        } catch (firstError: any) {
            if (firstError?.body?.code !== MFA_REQUIRED) {
                throw friendlyApiError(firstError, "Discord refused to remove the security key");
            }
            // Removing a key is itself a protected action: verify first.
            const token = await completeWebauthnMfa(firstError);
            try {
                await attempt(cred.id, { "X-Discord-MFA-Authorization": token } as any);
            } catch (secondError) {
                throw friendlyApiError(secondError, "Discord refused to remove the security key even after verification");
            }
        }
    }
}

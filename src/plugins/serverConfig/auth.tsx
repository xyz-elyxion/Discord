/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore } from "@webpack/common";

const DATA_STORE_KEY = "server-config-auth";
const BASE = "https://limey-discord.onrender.com/v1/server-config";

const logger = new Logger("ServerConfig");

export interface ServerConfigAuth {
    token?: string;
    discordId?: string;
}

export let Auth: ServerConfigAuth = {};

export async function initAuth() {
    Auth = await getAuth() ?? {};
}

/** Clears the stored token for the current user (e.g. when it's stale or invalid). */
export async function clearAuth() {
    await DataStore.update(DATA_STORE_KEY, auth => {
        auth ??= {};
        delete auth[UserStore.getCurrentUser()?.id];
        return auth;
    });
    Auth = {};
}

async function getAuth(): Promise<ServerConfigAuth | undefined> {
    const auth = await DataStore.get(DATA_STORE_KEY);
    return auth?.[UserStore.getCurrentUser()?.id];
}

async function updateAuth(newAuth: ServerConfigAuth) {
    return DataStore.update(DATA_STORE_KEY, auth => {
        auth ??= {};
        Auth = auth[UserStore.getCurrentUser().id] ??= {};

        if (newAuth.token) Auth.token = newAuth.token;
        if (newAuth.discordId) Auth.discordId = newAuth.discordId;

        return auth;
    });
}

// All Limey V1 OAuth flows share one redirect URI on the site backend,
// dispatched by the `state` query param (see server.js /v1/oauth/callback).
export const OAUTH_REDIRECT_URI = "https://limey-discord.onrender.com/v1/oauth/callback";

let cachedClientId: string | null = null;

async function getClientId(): Promise<string | null> {
    if (cachedClientId) return cachedClientId;
    try {
        const res = await fetch(`${BASE}/config`);
        if (!res.ok) return null;
        const { clientId } = await res.json();
        cachedClientId = clientId ?? null;
        return cachedClientId;
    } catch {
        return null;
    }
}

/**
 * Starts the Discord OAuth flow. Requires the "guilds" scope so the backend
 * can verify which guilds the user owns/manages before accepting config changes.
 */
export function authorize(callback?: () => void) {
    void (async () => {
        const clientId = await getClientId();
        if (!clientId) {
            showToast("Server Configuration backend is unavailable right now.", Toasts.Type.FAILURE);
            return;
        }

        openModal(props =>
            <OAuth2AuthorizeModal
                {...props}
                scopes={["identify", "guilds"]}
                responseType="code"
                redirectUri={OAUTH_REDIRECT_URI}
                permissions={0n}
                clientId={clientId}
                cancelCompletesFlow={false}
                callback={async (response: { location: string }) => {
                    try {
                        const url = new URL(response.location);
                        url.searchParams.set("state", "serverconfig");
                        const res = await fetch(url, {
                            headers: { Accept: "application/json" }
                        });

                        if (!res.ok) {
                            const { message } = await res.json();
                            showToast(message ?? "An error occured while authorizing", Toasts.Type.FAILURE);
                            return;
                        }

                        const { token, discordId } = await res.json();
                        await updateAuth({ token, discordId });
                        showToast("Successfully logged in!", Toasts.Type.SUCCESS);
                        callback?.();
                    } catch (e) {
                        logger.error("Failed to authorize", e);
                    }
                }}
            />
        );
    })();
}

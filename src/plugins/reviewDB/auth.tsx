/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2023 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { OAuth2AuthorizeModal, openModal, showToast, Toasts, UserStore } from "@webpack/common";

import { ReviewDBAuth } from "./entities";
import { API_URL } from "./reviewDbApi";

const DATA_STORE_KEY = "rdb-auth";

export let Auth: ReviewDBAuth = {};

export async function initAuth() {
    Auth = await getAuth() ?? {};
}

export async function getAuth(): Promise<ReviewDBAuth | undefined> {
    const auth = await DataStore.get(DATA_STORE_KEY);
    return auth?.[UserStore.getCurrentUser()?.id];
}

export async function getToken() {
    const auth = await getAuth();
    return auth?.token;
}

export async function updateAuth(newAuth: ReviewDBAuth) {
    return DataStore.update(DATA_STORE_KEY, auth => {
        auth ??= {};
        Auth = auth[UserStore.getCurrentUser().id] ??= {};

        if (newAuth.token) Auth.token = newAuth.token;
        if (newAuth.user) Auth.user = newAuth.user;

        return auth;
    });
}

let cachedClientId: string | null = null;

async function getClientId(): Promise<string | null> {
    if (cachedClientId) return cachedClientId;
    try {
        const res = await fetch(`${API_URL}/config`);
        if (!res.ok) return null;
        const { clientId } = await res.json();
        cachedClientId = clientId ?? null;
        return cachedClientId;
    } catch {
        return null;
    }
}

export function authorize(callback?: () => void) {
    void (async () => {
        const clientId = await getClientId();
        if (!clientId) {
            showToast("ReviewDB backend is unavailable right now.", Toasts.Type.FAILURE);
            return;
        }

        openModal(props =>
            <OAuth2AuthorizeModal
                {...props}
                scopes={["identify"]}
                responseType="code"
                redirectUri={`${API_URL}/auth`}
                permissions={0n}
                clientId={clientId}
                cancelCompletesFlow={false}
                callback={async (response: { location: string }) => {
                    try {
                        const url = new URL(response.location);
                        url.searchParams.append("clientMod", "limeyV1");
                        const res = await fetch(url, {
                            headers: { Accept: "application/json" }
                        });

                        if (!res.ok) {
                            const { message } = await res.json();
                            showToast(message ?? "An error occured while authorizing", Toasts.Type.FAILURE);
                            return;
                        }

                        const { token } = await res.json();
                        updateAuth({ token });
                        showToast("Successfully logged in!", Toasts.Type.SUCCESS);
                        callback?.();
                    } catch (e) {
                        new Logger("ReviewDB").error("Failed to authorize", e);
                    }
                }}
            />
        );
    })();
}

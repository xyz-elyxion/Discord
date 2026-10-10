/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { ApplicationCommandInputType, ApplicationCommandOptionType } from "@limeyV1/discord-types/enums";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByProps } from "@webpack";

const STORE_KEY = "accountManager.accounts";
const logger = new Logger("AccountManager");

const TOKEN_SUFFIXES = [".", "_", "-"];
/** Token shapes: bot tokens may be dotted, user tokens end in a base64-ish suffix. */
function looksLikeToken(token: string): boolean {
    return token.length >= 24 && TOKEN_SUFFIXES.some(suffix => token.includes(suffix));
}

export interface AccountEntry {
    id: string;
    name: string;
    addedAt: number;
    avatar?: string;
    email?: string;
    bot?: boolean;
}

type Accounts = Record<string, AccountEntry & { token: string }>;

let accounts: Accounts | null = null;

async function loadAccounts(): Promise<Accounts> {
    if (accounts) return accounts;
    accounts = (await DataStore.get<Accounts>(STORE_KEY)) ?? {};
    return accounts;
}

function persist(): Promise<void> {
    return DataStore.set(STORE_KEY, accounts);
}

function masked(token: string): string {
    return `${token.slice(0, 4)}${"•".repeat(Math.max(token.length - 8, 0))}${token.slice(-4)}`;
}

/**
 * Verify a token against the Discord REST API using the same authState module the
 * client's own login flow uses, so a failed/unauthorized account is caught before it
 * is ever stored.
 */
async function verifyToken(token: string): Promise<{ id: string; username: string; avatar: string | null; bot?: boolean; email?: string; }> {
    const auth = findByProps("getState", "logout", "getToken");
    const API = auth?.RestAPI ?? findByProps("get", "post", "del");
    if (!API) throw new Error("RestAPI not available.");

    const res = await API.get({
        url: "/users/@me",
        auth: false,
        headers: token
            ? { Authorization: token }
            : undefined,
    });
    const body = res?.body;
    if (!body?.id) throw new Error("Discord did not return an identity. The token is likely invalid.");
    return {
        id: body.id,
        username: body.username ?? "unknown",
        avatar: body.avatar ?? null,
        bot: body.bot,
        email: body.email ?? undefined,
    };
}

async function addAccount(tokenRaw: string, sendResult: (msg: string) => void): Promise<void> {
    const token = tokenRaw.trim();
    if (!looksLikeToken(token)) {
        sendResult("That does not look like a Discord token. Copy the full token from DevTools → Network → any `/api` request → `Authorization` header.");
        return;
    }

    const suspect = token.slice(24, 30);
    if (suspect.includes("<")) {
        sendResult("Token contains markup — for a user token, request `/api/v9/users/@me` in DevTools and copy the raw `Authorization` header value, not the copyable-token UI.");
        return;
    }

    const store = await loadAccounts();
    try {
        const me = await verifyToken(token);
        const existing: AccountEntry | undefined = store[me.id];
        store[me.id] = {
            id: me.id,
            name: existing?.name ?? me.username,
            addedAt: existing?.addedAt ?? Date.now(),
            avatar: me.avatar ?? existing?.avatar,
            email: me.email ?? existing?.email,
            bot: me.bot,
            token,
        };
        await persist();
        sendResult(`Account **${me.username}** (${me.id}) ${existing ? "updated" : "saved"}. Access via \`/account switch name:${me.username}\``);
    } catch (e) {
        logger.error("verifyToken failed");
        sendResult(`Could not verify token: ${e instanceof Error ? e.message : String(e)}`);
    }
}

async function switchAccount(tokenRaw: string, sendResult: (msg: string) => void): Promise<void> {
    const token = tokenRaw.trim();
    if (!looksLikeToken(token)) {
        sendResult("That does not look like a Discord token.");
        return;
    }
    const store = await loadAccounts();
    const me = await verifyToken(token);
    const entry = store[me.id];
    if (!entry) {
        sendResult(`Switch token is valid, but account ${me.id} is not saved yet. Use \`/account add\` with this token first.`);
        return;
    }
    switchToAccount(entry, sendResult);
}

async function switchToAccount(entry: AccountEntry & { token?: string }, sendResult: (msg: string) => void): Promise<void> {
    const token = entry?.token;
    if (!token) {
        sendResult("That account has no stored token.");
        return;
    }
    const auth = findByProps("logout", "getStore", "getToken");
    if (!auth) {
        sendResult("AuthState module not found — cannot switch accounts this build.");
        return;
    }
    try {
        await auth.logout();
    } catch (e) {
        logger.warn("authState.logout threw", e);
    }
    localStorage.setItem("token", JSON.stringify(token));
    sendResult(`Switching to **${entry.name}** (${entry.id}); reloading…`);
    location.assign(location.pathname);
}

export default definePlugin({
    name: "AccountManager",
    description: "Store, list, verify and switch between multiple Discord accounts from a single `/account` slash command.",
    authors: [Devs.syntt_],

    commands: [
        {
            name: "account",
            description: "Discord Account Manager",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "action",
                    description: "Action to perform",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        { name: "add", label: "Add an account", value: "add" },
                        { name: "switch", label: "Switch to a saved account", value: "switch" },
                        { name: "list", label: "List saved accounts", value: "list" },
                        { name: "remove", label: "Remove a saved account", value: "remove" },
                        { name: "whoami", label: "Show the current account", value: "whoami" },
                        { name: "export", label: "Export saved accounts as JSON", value: "export" },
                    ],
                },
                {
                    name: "token",
                    description: "Discord token (for add/switch)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
                {
                    name: "name",
                    description: "Account name (for switch by name)",
                    type: ApplicationCommandOptionType.STRING,
                    required: false,
                },
            ],
            execute: async (args, ctx) => {
                const reply = (content: string) => sendBotMessage(ctx.channel.id, { content });
                const action = String(args.find(a => a.name === "action")?.value ?? "list");
                const tokenArg = args.find(a => a.name === "token")?.value;
                const nameArg = args.find(a => a.name === "name")?.value;

                try {
                    switch (action) {
                        case "add": {
                            if (typeof tokenArg !== "string" || !tokenArg) {
                                reply("Usage: `/account action:add token:<your token>`");
                                return;
                            }
                            await addAccount(tokenArg, reply);
                            return;
                        }
                        case "switch": {
                            if (typeof tokenArg === "string" && tokenArg) {
                                await switchAccount(tokenArg, reply);
                                return;
                            }
                            if (typeof nameArg === "string" && nameArg) {
                                const store = await loadAccounts();
                                const matches = Object.values(store).filter(account => account.name === nameArg);
                                if (matches.length === 1) {
                                    await switchToAccount(matches[0], reply);
                                    return;
                                }
                                if (matches.length > 1) {
                                    reply(`Multiple accounts share the name "${nameArg}"; switch by token instead.`);
                                    return;
                                }
                                const known = Object.values(store).map(account => account.name).join(", ");
                                reply(`No account named "${nameArg}". Known accounts: ${known || "none"}.`);
                                return;
                            }
                            reply("Usage: `/account action:switch name:<saved name>` or `token:<token>`");
                            return;
                        }
                        case "list": {
                            const store = await loadAccounts();
                            const entries = Object.values(store);
                            if (entries.length === 0) {
                                reply("No accounts saved yet. Use `/account action:add token:<token>`.");
                                return;
                            }
                            const lines = entries
                                .sort((a, b) => a.addedAt - b.addedAt)
                                .map(account => {
                                    const markers: string[] = [];
                                    if (account.email) markers.push(`email: ${account.email}`);
                                    if (account.bot) markers.push("bot");
                                    return `• **${account.name}** — \`${account.id}\` (added <t:${Math.floor(account.addedAt / 1000)}:R>${markers.length ? `, ${markers.join(", ")}` : ""})`;
                                });
                            reply(`**Saved accounts (${entries.length})**\n${lines.join("\n")}`);
                            return;
                        }
                        case "remove": {
                            if (typeof nameArg !== "string" || !nameArg) {
                                reply("Usage: `/account action:remove name:<saved name>`");
                                return;
                            }
                            const store = await loadAccounts();
                            const entry = Object.values(store).find(account => account.name === nameArg);
                            if (!entry) {
                                reply(`No account named "${nameArg}".`);
                                return;
                            }
                            delete store[entry.id];
                            await persist();
                            reply(`Removed **${entry.name}** (${entry.id}).`);
                            return;
                        }
                        case "whoami": {
                            const raw = localStorage.getItem("token");
                            const current = raw ? JSON.parse(raw) : null;
                            if (typeof current !== "string" || !looksLikeToken(current)) {
                                reply("No usable token found in the client.");
                                return;
                            }
                            const me = await verifyToken(current);
                            reply(`Current account: **${me.username}** (${me.id}).`);
                            return;
                        }
                        case "export": {
                            const store = await loadAccounts();
                            await navigator.clipboard.writeText(JSON.stringify(store, null, 2));
                            reply("Saved accounts sent to your clipboard.");
                            return;
                        }
                        default:
                            reply("Unknown action. Try `/account action:list` first.");
                    }
                } catch (e) {
                    logger.error("AccountManager command failed", e);
                    reply(`AccountManager error: ${e instanceof Error ? e.message : String(e)}`);
                }
            },
        },
    ],
});

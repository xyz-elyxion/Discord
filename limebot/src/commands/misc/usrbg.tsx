/*
 * Limey V1 — /usrbg-add and /usrbg-remove commands
 * Lets server admins add/remove custom user banners (USRBG) served by
 * the Limey web backend (server.js, /v1/usrbg/*).
 */

import { MessageFlags } from "oceanic.js";

import { registerChatInputCommand } from "~/SlashCommands";

import { CommandStringOption, CommandUserOption } from "~components";

const BaseUrl = process.env.USRBG_URL || "https://limey-discord.onrender.com";
const AdminToken = process.env.USRBG_ADMIN_TOKEN || "";

// Only server admins can use these commands
function isAdmin(i: any) {
    const perms = i.member?.permissions;
    if (perms === undefined || perms === null) return false;
    try {
        return (BigInt(String(perms)) & 8n) !== 0n; // ADMINISTRATOR
    } catch {
        return false;
    }
}

async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${BaseUrl}/v1/usrbg${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${AdminToken}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
}

registerChatInputCommand(
    {
        name: "usrbg-add",
        description: "Give a user a custom USRBG profile banner",
        defaultMemberPermissions: "0",
        options: <>
            <CommandUserOption name="user" required />
            <CommandStringOption name="image-url" description="https URL of the banner image (600x240+ recommended)" required />
        </>
    },
    {
        guildOnly: true,
        async handle(i) {
            await i.defer(MessageFlags.EPHEMERAL);

            if (!isAdmin(i))
                return void i.createFollowup({ content: "Only server administrators can use this command.", flags: MessageFlags.EPHEMERAL });

            if (!AdminToken) {
                return void i.createFollowup({
                    content: "`USRBG_ADMIN_TOKEN` is not set — can't call the backend. Set the same value of that env var on both the web server and the bot.",
                    flags: MessageFlags.EPHEMERAL
                });
            }

            const user = i.data.options.getUser("user", true);
            const url = i.data.options.getString("image-url", true);
            try { new URL(url); } catch {
                return void i.createFollowup({ content: "That's not a valid URL.", flags: MessageFlags.EPHEMERAL });
            }

            const { ok, status, data } = await api("PUT", `/users/${user.id}`, { url });
            return void i.createFollowup({
                content: ok
                    ? `✅ Custom banner set for **${user.username}**. It will show up for anyone using Limey V1 with the USRBG plugin.`
                    : `❌ Backend error (${status}): ${JSON.stringify(data)}`,
                flags: MessageFlags.EPHEMERAL
            });
        }
    }
);

registerChatInputCommand(
    {
        name: "usrbg-remove",
        description: "Remove a user's custom USRBG profile banner",
        defaultMemberPermissions: "0",
        options: <>
            <CommandUserOption name="user" required />
        </>
    },
    {
        guildOnly: true,
        async handle(i) {
            await i.defer(MessageFlags.EPHEMERAL);

            if (!isAdmin(i))
                return void i.createFollowup({ content: "Only server administrators can use this command.", flags: MessageFlags.EPHEMERAL });

            if (!AdminToken) {
                return void i.createFollowup({
                    content: "`USRBG_ADMIN_TOKEN` is not set — can't call the backend.",
                    flags: MessageFlags.EPHEMERAL
                });
            }

            const user = i.data.options.getUser("user", true);
            const { ok, status, data } = await api("DELETE", `/users/${user.id}`);
            return void i.createFollowup({
                content: ok
                    ? `✅ Custom banner removed for **${user.username}**.`
                    : `❌ Backend error (${status}): ${JSON.stringify(data)}`,
                flags: MessageFlags.EPHEMERAL
            });
        }
    }
);

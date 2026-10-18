/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import type { User } from "@limeyV1/discord-types";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Forms, GuildStore, Menu, Modal, openModal, RelationshipStore, showToast, UserStore } from "@webpack/common";

import { analyzeUser, getBand, isAnalyzing } from "./analysis";
import CheckerModal, { cl, parseUserId } from "./components/CheckerModal";
import { settings } from "./settings";

function openChecker(userId?: string) {
    openModal(props => (
        <Modal {...props}
            size="md"
            title={
                <Flex className={cl("title")}>
                    <Forms.FormTitle tag="h2">Account Checker</Forms.FormTitle>
                </Flex>
            }
        >
            <ErrorBoundary noop>
                <CheckerModal initialUserId={userId} />
            </ErrorBoundary>
        </Modal>
    ));
}

const UserContextMenuPatch: (children, props: { user?: User; }) => void = (children, props) => {
    const { user } = props;
    if (!user) return;

    children.push(
        <Menu.MenuItem
            id="vc-account-checker"
            label="Check Account"
            action={() => openChecker(user.id)}
        />
    );
};

export default definePlugin({
    name: "AccountChecker",
    description: "Advanced Discord account checks — snowflake age, badges (incl. unobtainable), Nitro, profile investment, spam/block flags, bot detection, username↔display-name swap, bait keywords and a full pass/warn checklist. Adds a /accountcheck command and a 'Check Account' option in user context menus.",
    tags: ["Utility", "Friends"],
    searchTerms: ["account", "checker", "safety", "alt", "quality", "age", "badges", "progressive checks", "scam", "spam flags"],
    authors: [Devs.Limey],

    permissions: [
        {
            id: "readProfileData",
            title: "Read user profile data",
            description: "Requests profile fields (badges, Nitro tier, banner, bio, clubs) through Discord for the account you check.",
            risk: "Results are fetched with your session; Discord sees these requests as coming from your account."
        },
        {
            id: "registerCommands",
            title: "Register commands",
            description: "Adds the /accountcheck, /friendgraph and /servergraph commands.",
            risk: "The command reads the user ID you type into it, and the graph exports copy your own friend list or server names to the clipboard."
        },
        {
            id: "contextMenus",
            title: "Add context menu entries",
            description: "Adds a 'Check Account' entry to the right-click menu on a user.",
            risk: "Triggered only when you click it, on the user you chose; no data is modified."
        }
    ],

    settings,

    contextMenus: {
        "user-context": UserContextMenuPatch
    },

    commands: [
        {
            name: "friendgraph",
            description: "Copy your friends as JSON graph data for the Tools-page Friend Graph Visualiser",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute(_opts, { channel }) {
                const count = RelationshipStore.getFriendCount();
                const friendIds = RelationshipStore.getFriendIDs();
                const me = UserStore.getCurrentUser();
                const meName = me?.globalName ?? me?.username ?? "You";
                const friends = friendIds
                    .map(id => {
                        const user = UserStore.getUser(id);
                        return user ? (user.globalName ?? user.username) : null;
                    })
                    .filter(n => typeof n === "string" && n.length > 0);

                // copyToClipboard resolves a promise on web but returns void on
                // Discord desktop (DiscordNative.clipboard.copy), so await it in
                // a try/catch instead of chaining .then directly.
                (async () => {
                    try {
                        await copyToClipboard(JSON.stringify({ me: meName, friends }));
                        sendBotMessage(channel.id, {
                            content: `🕸 **${count}** friends copied as graph JSON. Paste it into the **Friend Graph Visualiser** on the Limey V1 Tools page — paste several people's exports to see shared friends between groups.`
                        });
                    } catch (e) {
                        console.error("[AccountChecker] friendgraph copy failed", e);
                        showToast("Couldn't copy your friend graph to the clipboard", "failure");
                    }
                })();
            }
        },
        {
            name: "servergraph",
            description: "Copy your servers as JSON graph data for the Tools-page Server Graph Visualiser",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute(_opts, { channel }) {
                const me = UserStore.getCurrentUser();
                const meName = me?.globalName ?? me?.username ?? "You";
                const guilds: { name?: string; }[] = GuildStore?.getGuildsArray?.() ?? [];
                const servers = guilds
                    .map(g => g?.name)
                    .filter(n => typeof n === "string" && n.length > 0);

                // copyToClipboard resolves a promise on web but returns void on
                // Discord desktop (DiscordNative.clipboard.copy), so await it in
                // a try/catch instead of chaining .then directly.
                (async () => {
                    try {
                        await copyToClipboard(JSON.stringify({ me: meName, servers }));
                        sendBotMessage(channel.id, {
                            content: `🏰 **${servers.length}** servers copied as graph JSON. Paste it into the **Server Graph Visualiser** on the Limey V1 Tools page — paste several people's exports to see shared servers between people.`
                        });
                    } catch (e) {
                        console.error("[AccountChecker] servergraph copy failed", e);
                        showToast("Couldn't copy your server graph to the clipboard", "failure");
                    }
                })();
            }
        },
        {
            name: "accountcheck",
            description: "Check a Discord account's age, badges and profile investment",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "user",
                    description: "User id, @mention or discord.com/users/… link",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute(opts, { channel }) {
                const input = opts[0]?.value as string;
                const userId = parseUserId(input ?? "");
                if (!userId)
                    return sendBotMessage(channel.id, { content: "❌ Couldn't read a user id — use their id, a <@mention> or a discord.com/users/… link." });

                if (isAnalyzing(userId))
                    return sendBotMessage(channel.id, { content: "⏳ Already checking that account… try again in a second." });

                analyzeUser(userId)
                    .then(analysis => {
                        if (!analysis)
                            return sendBotMessage(channel.id, { content: `❌ User <@${userId}> isn't in your cache. Open their profile once, or check the exact id.` });

                        const band = getBand(analysis.score);
                        const warns = analysis.checks.filter(c => c.level === "warn");
                        const parts = [
                            `🔍 **Account Checker** — **${analysis.displayName}** (${analysis.userId})`,
                            `${band.emoji} **${band.label}** — \`${analysis.score}/100\` · ${band.note}`,
                            `- Created: **${analysis.createdAtLabel}** (${analysis.ageDays.toLocaleString()} days old)`,
                            `- Badges: ${analysis.badgeDetails.length ? analysis.badgeDetails.map(b => b.id + (b.expired ? " ⚠️" : "")).join(", ") : "none"}`,
                            `- Nitro: ${analysis.hasNitro ? "yes" : "no"} · Banner: ${analysis.hasBanner ? "yes" : "no"} · Bio: ${analysis.hasBio ? "yes" : "no"}`,
                            `- Connected accounts: ${analysis.connectedAccountCount}`,
                        ];
                        if (warns.length) {
                            parts.push(`⚠️ **Flagged:** ${warns.map(c => c.label).join(", ")}`);
                        }
                        parts.push("", "_Heuristic, not proof — treat it like a vibe check._");
                        openModal(props => (
                            <Modal {...props}
                                size="md"
                                title={<Forms.FormTitle tag="h2">Account Checker — {analysis.displayName}</Forms.FormTitle>}
                            >
                                <ErrorBoundary noop>
                                    <CheckerModal initialUserId={analysis.userId} />
                                </ErrorBoundary>
                            </Modal>
                        ));
                    })
                    .catch(e => {
                        showToast("Account Checker crashed — see console", "failure");
                        console.error("[AccountChecker]", e);
                    });
            }
        }
    ],

    toolboxActions() {
        return {
            "Open Account Checker": () => openChecker()
        };
    }
});

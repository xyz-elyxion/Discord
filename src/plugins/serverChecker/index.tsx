/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey V1 contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, sendBotMessage } from "@api/Commands";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import type { Guild } from "@limeyV1/discord-types";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Forms, Menu, Modal, openModal } from "@webpack/common";

import { analyzeGuild, analyzeInvite, getBand } from "./analysis";
import CheckerModal, { cl, parseGuildInput } from "./components/CheckerModal";

function openChecker(initialInput?: string) {
    openModal(props => (
        <Modal {...props}
            size="md"
            title={
                <Flex className={cl("title")}>
                    <Forms.FormTitle tag="h2">Server Checker</Forms.FormTitle>
                </Flex>
            }
        >
            <ErrorBoundary noop>
                <CheckerModal initialInput={initialInput} />
            </ErrorBoundary>
        </Modal>
    ));
}

const GuildContextMenuPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild?.id) return;
    const group = findGroupChildrenByChildId("privacy", children);

    group?.push(
        <Menu.MenuItem
            id="vc-server-checker"
            label="Check Server"
            action={() => openChecker(guild.id)}
        />
    );
};

export default definePlugin({
    name: "ServerChecker",
    description: "Check any Discord server's trust signals before you even join — age from the guild snowflake, verification level, boosts, AutoMod, raid alerts, welcome/onboarding, Verified/Partnered status, NSFW rating, trust features, emoji/sticker culture. Works from invite links, guild IDs, /servercheck and a right-click menu entry.",
    tags: ["Servers", "Utility"],
    searchTerms: ["server", "checker", "guild", "safety", "invite", "scam", "verification", "automod"],
    authors: [Devs.Limey],

    permissions: [
        {
            id: "readGuildData",
            title: "Read server data",
            description: "Reads verification level, boosts, features, NSFW rating and emoji/sticker counts for a server from your client's cache, and resolves invite links through Discord.",
            risk: "Invite resolution uses your session; Discord sees these requests as coming from your account."
        },
        {
            id: "registerCommands",
            title: "Register commands",
            description: "Adds the /servercheck command.",
            risk: "The command reads the invite or server ID you type into it; nothing is modified."
        },
        {
            id: "contextMenus",
            title: "Add context menu entries",
            description: "Adds a 'Check Server' entry to the right-click menu on a server.",
            risk: "Triggered only when you click it; no data is modified."
        }
    ],

    contextMenus: {
        "guild-context": GuildContextMenuPatch,
        "guild-header-popout": GuildContextMenuPatch
    },

    commands: [
        {
            name: "servercheck",
            description: "Check a server's age, verification, boosts, AutoMod and trust signals",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "server",
                    description: "Server ID or discord.gg/… invite link",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                }
            ],
            execute(opts, { channel }) {
                const input = opts[0]?.value as string;
                const parsed = parseGuildInput(input ?? "");
                if (!parsed)
                    return sendBotMessage(channel.id, { content: "❌ Couldn't read that — paste a server ID or a discord.gg/… invite link." });

                if (parsed.kind === "invite") {
                    analyzeInvite(parsed.value)
                        .then(analysis => {
                            if (!analysis)
                                return sendBotMessage(channel.id, { content: "❌ Couldn't resolve that invite — is the code right, and hasn't expired?" });

                            const band = getBand(analysis.score);
                            sendBotMessage(channel.id, {
                                content: [
                                    `🏰 **Server Checker** — **${analysis.name}**${analysis.joined ? "" : " (from invite)"}`,
                                    `${band.emoji} **${band.label}** — \`${analysis.score}/100\` · ${band.note}`,
                                    `- Created: **${analysis.createdAtLabel}** (${analysis.ageDays.toLocaleString()} days old)`,
                                    `- Verification: **${["None", "Low", "Medium", "High", "Highest"][analysis.verificationLevel] ?? "?"}** · Boosts: **${analysis.boostCount}** (Level ${analysis.premiumTier})`,
                                    `- Trust features: ${analysis.trustFeatures.length ? analysis.trustFeatures.join(", ") : "none"}`,
                                    "",
                                    "_Heuristic, not proof — look inside before trusting, even on verified servers._",
                                ].join("\n")
                            });
                        })
                        .catch(() => {
                            sendBotMessage(channel.id, { content: "❌ Invite resolution failed — try again or use the open modal." });
                        });
                    openChecker(input);
                    return;
                }

                analyzeGuild(parsed.value)
                    .then(analysis => {
                        if (!analysis)
                            return sendBotMessage(channel.id, { content: "❌ Server not joined. Paste a discord.gg/… invite link to check it without joining." });

                        const band = getBand(analysis.score);
                        sendBotMessage(channel.id, {
                            content: [
                                `🏰 **Server Checker** — **${analysis.name}**`,
                                `${band.emoji} **${band.label}** — \`${analysis.score}/100\` · ${band.note}`,
                                `- Created: **${analysis.createdAtLabel}** (${analysis.ageDays.toLocaleString()} days old)`,
                                `- Verification: **${["None", "Low", "Medium", "High", "Highest"][analysis.verificationLevel] ?? "?"}** · Boosts: **${analysis.boostCount}** (Level ${analysis.premiumTier})`,
                                `- Trust features: ${analysis.trustFeatures.length ? analysis.trustFeatures.join(", ") : "none"}`,
                                "",
                                "_Heuristic, not proof — look inside before trusting._",
                            ].join("\n")
                        });
                        openChecker(parsed.value);
                    })
                    .catch(() => {
                        sendBotMessage(channel.id, { content: "❌ Something went wrong checking that server." });
                    });
            }
        }
    ],

    toolboxActions() {
        return {
            "Open Server Checker": () => openChecker()
        };
    }
});

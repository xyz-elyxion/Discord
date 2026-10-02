/**
 * Database type declarations for Kysely.
 *
 * Normally generated with `pnpm sql:types` (kysely-codegen), but declared
 * manually here so the types are available in environments where the
 * sqlite3 CLI / native bindings aren't available (e.g. CI sandboxes).
 * If you add a table to sql/create.sql, update this file too.
 */
declare module "kysely-codegen" {
import type { ColumnType } from "kysely";

/** Auto-increment column: always present on select, optional on insert/update (matches kysely-codegen output) */
export type Generated<T> = ColumnType<T, never, T>;

export interface Tickets {
        id: Generated<number>;
        userId: string;
        channelId: string;
    }

    export interface Expressions {
        id: string;
        name: string;
        formatType: "png" | "apng" | "gif" | "lottie";
    }

    export interface ExpressionUses {
        id: string;
        expressionType: "emoji" | "sticker";
        usageType: "message" | "reaction";
        userId: string;
        messageId: string;
    }

    export interface StickyRoles {
        id: string;
        roleIds: string;
    }

    export interface LinkedGitHubs {
        githubId: string;
        discordId: string;
    }

    export interface UserAvatarEmojis {
        userId: string;
        emojiId: string;
        avatarHash: string;
    }

    export interface Xp {
        userId: string;
        xp: number;
    }

    export interface Warnings {
        id: Generated<number>;
        userId: string;
        guildId: string;
        moderator: string;
        reason: string;
        createdAt: string;
    }

    export interface VerificationConfigs {
        guildId: string;
        channelId: string;
        roleId: string;
        rulesChannelId: string | null;
        rulesText: string | null;
        enabled: number;
        createdBy: string;
        createdAt: string;
    }

    export interface VerificationTokens {
        token: string;
        guildId: string;
        userId: string;
        used: number;
        createdAt: string;
    }

    export interface ScheduledUnbans {
        userId: string;
        guildId: string;
        unbanAt: string;
        reason: string;
        moderator: string;
    }

    export interface DB {
        tickets: Tickets;
        expressions: Expressions;
        expressionUses: ExpressionUses;
        stickyRoles: StickyRoles;
        linkedGitHubs: LinkedGitHubs;
        userAvatarEmojis: UserAvatarEmojis;
        xp: Xp;
        warnings: Warnings;
        scheduledUnbans: ScheduledUnbans;
        verificationTokens: VerificationTokens;
        verificationConfigs: VerificationConfigs;
    }
}

import { existsSync, mkdirSync, readFileSync } from "fs";
import Sqlite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
// generate via `pnpm sql:types`
import type { DB } from "kysely-codegen";

// Single-file hosts (e.g. WispByte runs the bot directly, no "pnpm start", so
// no sql:up step) — create the data dir before opening the DB.
mkdirSync("data", { recursive: true });

const sqlite = new Sqlite("./data/db.sqlite3");
sqlite.pragma("journal_mode = WAL");

// Self-healing schema: apply sql/create.sql directly through better-sqlite3
// (all CREATE statements are IF NOT EXISTS, so this is idempotent everywhere).
if (existsSync("./sql/create.sql"))
    sqlite.exec(readFileSync("./sql/create.sql", "utf8"));

const dialect = new SqliteDialect({
    database: sqlite
});

export const db = new Kysely<DB>({ dialect });

export const enum ExpressionType {
    EMOJI = "emoji",
    STICKER = "sticker",
}

export const enum ExpressionUsageType {
    MESSAGE = "message",
    REACTION = "reaction",
}

export const enum ExpressionFormatType {
    PNG = "png",
    APNG = "apng",
    GIF = "gif",
    LOTTIE = "lottie"
}

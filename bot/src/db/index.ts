import { existsSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import Sqlite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
// generate via `pnpm sql:types`
import type { DB } from "kysely-codegen";

// Anchor the data dir and schema file to THIS module's compiled location
// (the esbuild bundle lives in bot/dist, so ".." is the bot package
// root), not to the process working directory: single-file hosts like
// WispByte run `node .../dist/botOnly.js` from the container root, and a
// cwd-relative "./data" would create a fresh, schema-less database there.
// Esbuild bundles every src module into that dist file and keeps
// __dirname intact, so this resolves correctly wherever the bundle runs.
const runtimeRoot = path.resolve(__dirname, "..");
export const dataDir = path.join(runtimeRoot, "data");

// Also create the data dir for single-file hosts (e.g. WispByte runs the bot
// directly, no "pnpm start", so no sql:up step runs first).
mkdirSync(dataDir, { recursive: true });

const sqlite = new Sqlite(path.join(dataDir, "db.sqlite3"));
sqlite.pragma("journal_mode = WAL");

// Self-healing schema: apply sql/create.sql directly through better-sqlite3
// (all CREATE statements are IF NOT EXISTS, so this is idempotent everywhere).
const createSql = path.join(runtimeRoot, "sql", "create.sql");
if (existsSync(createSql))
    sqlite.exec(readFileSync(createSql, "utf8"));

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

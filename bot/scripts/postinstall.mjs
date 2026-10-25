/*
 * Limebot postinstall — must not depend on pnpm or the sqlite3 CLI so plain
 * `npm install` (single-file hosts like WispByte) works too. Gracefully no-ops
 * when better-sqlite3 has no native binding available yet (that bundle is
 * rebuilt separately, e.g. `npm rebuild better-sqlite3`).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";

mkdirSync("data", { recursive: true });

if (existsSync("sql/create.sql")) {
    try {
        const sqliteModule = await import("better-sqlite3");
        const Sqlite = sqliteModule.default;
        const db = new Sqlite("data/db.sqlite3");
        db.exec(readFileSync("sql/create.sql", "utf8"));
        db.close();
        console.log("[limebot] data/ created and schema applied");
    } catch (e) {
        console.log(`[limebot] skipped SQLite schema bootstrap (better-sqlite3 binding not ready yet): ${e?.message ?? e}`);
    }
}

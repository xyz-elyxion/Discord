/*
 * Bot state persistence — the bot's SQLite database lives on the Render
 * container's ephemeral filesystem, so every restart/deploy wipes counting
 * progress and all feature configs. This module mirrors the feature tables
 * into the web server's durable Postgres kv store (via /v1/bot-state, authed
 * with the shared admin token) and restores them into a fresh SQLite DB on
 * boot. Local SQLite stays the source of truth at runtime; Postgres is the
 * cold backup that survives container recreation.
 */

import { db } from "~/db";

// All feature tables that must survive restarts.
const TABLES = [
    "countingConfigs",
    "verificationConfigs",
    "welcomerConfigs",
    "levelingConfigs",
    "autoroleConfigs",
    "reactionRoleConfigs",
    "starboardConfigs",
    "starboardEntries",
    "suggestionConfigs"
] as const;

type TableName = (typeof TABLES)[number];

const BASE = process.env.LIMEY_STATE_BASE_URL || "https://limey-discord.onrender.com";
const TOKEN = process.env.LIMEBOT_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN || "";

async function api<T>(method: string, key: string, body?: unknown): Promise<T | null> {
    if (!TOKEN) return null;
    try {
        const res = await fetch(`${BASE}/v1/bot-state/${key}`, {
            method,
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${TOKEN}`
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json() as T;
    } catch (err) {
        console.error(`[bot-state] ${method} ${key} failed:`, err);
        return null;
    }
}

async function getTable(table: TableName): Promise<any[]> {
    return (await api<any[]>("GET", table)) ?? [];
}

async function putTable(table: TableName, rows: unknown[]): Promise<void> {
    if (rows.length) await api("PUT", table, rows);
}

async function rowCount(table: TableName): Promise<number> {
    const rows = await db.selectFrom(table as any).selectAll().execute();
    return rows.length;
}

async function insertRows(table: TableName, rows: any[]): Promise<void> {
    for (const row of rows) {
        await (db.insertInto(table as any).values(row as any) as any).execute();
    }
}

/**
 * Restores the feature tables from the durable kv store into a fresh
 * (empty) SQLite database. Only inserts rows when the local table is
 * empty, so a live dev environment with its own data is never clobbered.
 */
export async function restoreBotState() {
    try {
        for (const table of TABLES) {
            const rows = await getTable(table);
            if (!rows.length) continue;
            if (await rowCount(table)) continue;
            await insertRows(table, rows);
            console.log(`[bot-state] restored ${rows.length} row(s) into ${table}`);
        }
    } catch (err) {
        console.error("[bot-state] restore failed:", err);
    }
}

/**
 * Periodically pushes feature tables that changed to the kv store.
 * Tables are tiny (a handful of rows), so a diff-check every 15s is cheap.
 */
export function startBotStateSync(intervalMs = 15_000) {
    let lastSnapshot = "";

    const push = async () => {
        try {
            const snapshot: Record<string, unknown[]> = {};
            let total = 0;
            for (const table of TABLES) {
                const rows = await db.selectFrom(table as any).selectAll().execute();
                snapshot[table] = rows;
                total += rows.length;
            }

            // Never clobber stored state with an all-empty snapshot before
            // we've seen any local data (e.g. restore failed at boot).
            if (total === 0 && lastSnapshot === "") return;

            const json = JSON.stringify(snapshot);
            if (json === lastSnapshot) return;

            for (const table of TABLES) {
                await putTable(table, snapshot[table]!);
            }
            lastSnapshot = json;
        } catch (err) {
            console.error("[bot-state] sync failed:", err);
        }
    };

    void push();
    setInterval(() => void push(), intervalMs).unref();
}

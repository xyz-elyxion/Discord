/*
 * Limey V1 — PostgreSQL-backed key-value store.
 * Drop-in replacement for the previous Redis kv layer in server.js.
 * Stores each kv key as a row in the `limey_kv` table (JSONB value).
 */
"use strict";

const { Pool } = require("pg");

const DATABASE_URL =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    "";

let pool = null;
let readyPromise = null;

function pgEnabled() {
    return Boolean(DATABASE_URL);
}

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: DATABASE_URL,
            ssl: DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
                ? undefined
                : { rejectUnauthorized: false },
            max: 5,
        });
        pool.on("error", err => console.error("[pgkv] pool error:", err.message));
    }
    return pool;
}

// Create the kv table if it does not exist.
function initPgKv() {
    if (!pgEnabled()) return Promise.resolve(false);
    if (!readyPromise) {
        readyPromise = getPool()
            .query(
                `CREATE TABLE IF NOT EXISTS limey_kv (
                    key TEXT PRIMARY KEY,
                    value JSONB NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                )`
            )
            .then(() => {
                console.log("[pgkv] ready");
                return true;
            })
            .catch(err => {
                console.error("[pgkv] init failed:", err.message);
                readyPromise = null;
                return false;
            });
    }
    return readyPromise;
}

async function pgSet(key, value) {
    if (!pgEnabled()) return;
    try {
        await initPgKv();
        await getPool().query(
            `INSERT INTO limey_kv (key, value, updated_at) VALUES ($1, $2::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [key, JSON.stringify(value ?? null)]
        );
    } catch (err) {
        console.error(`[pgkv] set ${key} failed:`, err.message);
    }
}

async function pgGet(key) {
    if (!pgEnabled()) return null;
    try {
        await initPgKv();
        const res = await getPool().query(`SELECT value FROM limey_kv WHERE key = $1`, [key]);
        if (!res.rows.length) return null;
        const v = res.rows[0].value;
        return typeof v === "string" ? v : JSON.stringify(v);
    } catch (err) {
        console.error(`[pgkv] get ${key} failed:`, err.message);
        return null;
    }
}

// Delete every row in the kv table (and any other limey_* data tables).
async function pgClearAll() {
    if (!pgEnabled()) return false;
    await initPgKv();
    await getPool().query("TRUNCATE TABLE limey_kv");
    console.log("[pgkv] cleared all data (limey_kv truncated)");
    return true;
}

module.exports = { pgEnabled, initPgKv, pgSet, pgGet, pgClearAll, getPool };

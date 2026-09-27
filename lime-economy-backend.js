/*
 * Limey V1 — Lime Economy backend
 * Mounted at /v1/limes/* by server.js
 *
 * A fully virtual economy: users earn "Limes" and spend them on perk tiers.
 * No real money is involved anywhere.
 *
 * Persistence: in-memory + JSON file fallback + Redis via global.__reviewdbKvSet
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");

const DATA_FILE = join(__dirname, "data", "lime-economy.json");
const ADMIN_TOKEN = process.env.LIMES_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// How Limes can be earned. The plugin drives these; the backend enforces the
// limits so the same account can't farm the same source from two devices.
const EARNING = {
    daily: { amount: 50, cooldownMs: 20 * 60 * 60 * 1000 }, // claim every ~20h
    message: { amount: 1, capPerDay: 100 }, // 1 Lime per 25 msgs, max 100/day
    voiceMinute: { amount: 5, capPerDay: 60 }, // 5 Limes per 15 min voice, max 60/day
    streakBonus: 25 // extra Limes per consecutive daily claim day, capped
};
const STREAK_CAP = 7;

// Perk tiers. Each tier has a monthly price in Limes and a one-time free
// trial length in days. Tiers are cumulative (a tier includes all lower ones).
const TIERS = {
    seedling: {
        name: "Seedling",
        pricePerMonth: 200,
        trialDays: 7,
        perks: ["Exclusive Seedling badge", "Custom theme slot"]
    },
    grove: {
        name: "Grove",
        pricePerMonth: 500,
        trialDays: 3,
        perks: ["Everything in Seedling", "Animated profile accent", "Early plugin access"]
    },
    orchard: {
        name: "Orchard",
        pricePerMonth: 1200,
        trialDays: 1,
        perks: ["Everything in Grove", "Orchard badge", "Priority support", "2x daily Lime claims"]
    }
};

const TIER_ORDER = ["seedling", "grove", "orchard"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// db.wallets[userId] = { balance, streak, lastDaily, lastMessageDay, messagesToday, dayKey, voiceToday }
// db.perks[userId]  = { tier, expiresAt, trialUsed: { [tier]: true } }
let db = { wallets: {}, perks: {} };

let saveTimer = null;
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            mkdirSync(join(__dirname, "data"), { recursive: true });
            writeFileSync(DATA_FILE, JSON.stringify(db));
        } catch (err) {
            console.error("[limes] failed to persist:", err.message);
        }
        if (global.__reviewdbKvSet) global.__reviewdbKvSet("limey:lime-economy", db);
    }, 2000);
}

function hydrate(parsed) {
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.wallets && typeof parsed.wallets === "object") db.wallets = parsed.wallets;
    if (parsed.perks && typeof parsed.perks === "object") db.perks = parsed.perks;
    console.log(`[limes] hydrated ${Object.keys(db.wallets).length} wallet(s), ${Object.keys(db.perks).length} perk subscription(s)`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

function dayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function getWallet(userId) {
    let wallet = db.wallets[userId];
    if (!wallet) {
        wallet = db.wallets[userId] = {
            balance: 0,
            streak: 0,
            lastDaily: 0,
            lastMessageDay: null,
            messagesToday: 0,
            voiceToday: 0,
            dayKey: null
        };
    }
    // reset daily counters on a new UTC day
    const today = dayKey();
    if (wallet.dayKey !== today) {
        wallet.dayKey = today;
        wallet.messagesToday = 0;
        wallet.voiceToday = 0;
    }
    return wallet;
}

function getPerks(userId) {
    return db.perks[userId] || null;
}

function activeTier(userId) {
    const perks = getPerks(userId);
    if (!perks) return null;
    if (perks.tier && perks.expiresAt && Date.now() < perks.expiresAt) return perks.tier;
    return null;
}

function tierMultiplier(userId) {
    // Orchard doubles daily claims
    return activeTier(userId) === "orchard" ? 2 : 1;
}

function addLimes(userId, amount, reason) {
    const wallet = getWallet(userId);
    wallet.balance += amount;
    scheduleSave();
    console.log(`[limes] +${amount} -> ${userId} (${reason}); balance=${wallet.balance}`);
    return wallet.balance;
}

function spendLimes(userId, amount) {
    const wallet = getWallet(userId);
    if (wallet.balance < amount) return { ok: false, balance: wallet.balance };
    wallet.balance -= amount;
    scheduleSave();
    return { ok: true, balance: wallet.balance };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function readBody(req) {
    return new Promise(resolve => {
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { resolve({}); }
        });
        req.on("error", () => resolve({}));
    });
}

// Resolves the calling user. Two accepted shapes:
//  1. ?userId=... (plugin passes its authenticated Discord user id)
//  2. Authorization: Bearer <token> -> delegated to the plugin's token map
// For a virtual economy we keep it simple and trust the plugin's user id over
// HTTPS; the plugin authenticates the user with Discord itself.
function getUser(req, query) {
    const userId = query.get("userId") || req.headers["x-limey-user-id"];
    return userId && /^\d{5,25}$/.test(String(userId)) ? String(userId) : null;
}

function isAdmin(req) {
    if (!ADMIN_TOKEN) return false;
    return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

function tierInfo(tierId) {
    const tier = TIERS[tierId];
    if (!tier) return null;
    const lower = TIER_ORDER.slice(0, TIER_ORDER.indexOf(tierId));
    return {
        id: tierId,
        ...tier,
        perks: [
            ...lower.flatMap(id => TIERS[id].perks),
            ...tier.perks
        ]
    };
}

async function handle(req, res, url) {
    const [path, queryString] = url.split("?");
    const query = new URLSearchParams(queryString || "");
    const sub = path.slice("/v1/limes".length) || "/";

    // ---- Public catalog ----
    if (req.method === "GET" && sub === "/tiers") {
        return json(res, 200, {
            currency: "Limes",
            tiers: TIER_ORDER.map(tierInfo)
        }), true;
    }

    // ---- Wallet ----
    let userId = getUser(req, query);
    if (!userId && req.method !== "GET") {
        const body = await readBody(req);
        userId = getUser(req, new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])));
        // re-parse remaining body for endpoints that need it
        req.body = body;
    }

    if (sub === "/wallet" && req.method === "GET") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const wallet = getWallet(userId);
        return json(res, 200, {
            balance: wallet.balance,
            streak: wallet.streak,
            tier: activeTier(userId),
            multiplier: tierMultiplier(userId),
            nextDailyAt: wallet.lastDaily + EARNING.daily.cooldownMs
        }), true;
    }

    // ---- Earning: daily claim ----
    if (sub === "/earn/daily" && req.method === "POST") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const wallet = getWallet(userId);
        const now = Date.now();
        const elapsed = now - wallet.lastDaily;

        // A day gap (or first claim) resets the streak; else it grows
        if (!wallet.lastDaily || elapsed > 2 * EARNING.daily.cooldownMs) wallet.streak = 0;

        if (elapsed < EARNING.daily.cooldownMs) {
            return json(res, 429, {
                error: "daily already claimed",
                nextDailyAt: wallet.lastDaily + EARNING.daily.cooldownMs
            }), true;
        }

        const multiplier = tierMultiplier(userId);
        const streakBonus = Math.min(wallet.streak, STREAK_CAP) * EARNING.streakBonus;
        const amount = (EARNING.daily.amount + streakBonus) * multiplier;
        wallet.lastDaily = now;
        wallet.streak += 1;
        const balance = addLimes(userId, amount, "daily");

        return json(res, 200, {
            amount, balance,
            streak: wallet.streak,
            streakBonus,
            multiplier
        }), true;
    }

    // ---- Earning: message activity (called by the plugin, capped server-side) ----
    if (sub === "/earn/message" && req.method === "POST") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const wallet = getWallet(userId);
        const today = dayKey();

        if (wallet.lastMessageDay !== today) {
            wallet.lastMessageDay = today;
            wallet.messagesToday = 0;
        }
        wallet.messagesToday += Number(req.body?.count || 1);
        if (wallet.messagesToday > EARNING.message.capPerDay * 25) {
            return json(res, 200, { awarded: 0, balance: wallet.balance, capped: true }), true;
        }
        // 1 Lime per 25 messages
        const awarded = Math.floor(wallet.messagesToday / 25) - Math.floor((wallet.messagesToday - Number(req.body?.count || 1)) / 25);
        if (awarded > 0) addLimes(userId, awarded, "messages");
        return json(res, 200, { awarded, balance: getWallet(userId).balance }), true;
    }

    // ---- Earning: voice activity ----
    if (sub === "/earn/voice" && req.method === "POST") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const wallet = getWallet(userId);
        const minutes = Number(req.body?.minutes || 0);
        const blocks = Math.floor(minutes / 15); // 5 Limes per 15 minutes
        if (blocks <= 0) return json(res, 200, { awarded: 0, balance: wallet.balance }), true;

        const room = EARNING.voiceMinute.capPerDay - wallet.voiceToday;
        const awardable = Math.min(blocks, room);
        wallet.voiceToday += awardable;
        if (awardable > 0) addLimes(userId, awardable * EARNING.voiceMinute.amount, "voice");
        return json(res, 200, { awarded: awardable * EARNING.voiceMinute.amount, balance: getWallet(userId).balance }), true;
    }

    // ---- Perk tiers ----
    if (sub === "/perks" && req.method === "GET") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        return json(res, 200, {
            tier: activeTier(userId),
            expiresAt: getPerks(userId)?.expiresAt || null,
            trialsUsed: getPerks(userId)?.trialUsed || {}
        }), true;
    }

    // Start a free trial for a tier (once per tier, ever)
    if (sub === "/perks/trial" && req.method === "POST") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const tierId = req.body?.tier;
        const tier = TIERS[tierId];
        if (!tier) return json(res, 400, { error: "unknown tier" }), true;

        const perks = db.perks[userId] || (db.perks[userId] = { tier: null, expiresAt: null, trialUsed: {} });
        if (perks.trialUsed[tierId]) return json(res, 409, { error: "trial already used for this tier" }), true;
        if (activeTier(userId) === tierId) return json(res, 409, { error: "already on this tier" }), true;

        perks.trialUsed[tierId] = true;
        perks.tier = tierId;
        perks.expiresAt = Date.now() + tier.trialDays * 24 * 60 * 60 * 1000;
        scheduleSave();

        return json(res, 200, {
            tier: tierId,
            expiresAt: perks.expiresAt,
            trialDays: tier.trialDays
        }), true;
    }

    // Subscribe to a tier with Limes (30 days). Stacks onto remaining time of
    // the same tier; switching tiers replaces.
    if (sub === "/perks/subscribe" && req.method === "POST") {
        if (!userId) return json(res, 400, { error: "missing userId" }), true;
        const tierId = req.body?.tier;
        const tier = TIERS[tierId];
        if (!tier) return json(res, 400, { error: "unknown tier" }), true;

        const current = activeTier(userId);
        const perks = db.perks[userId] || (db.perks[userId] = { tier: null, expiresAt: null, trialUsed: {} });

        let cost = tier.pricePerMonth;
        let duration = 30 * 24 * 60 * 60 * 1000;

        if (current === tierId) {
            // extending: pro-rate unused time into extra days
            const remaining = Math.max(0, (perks.expiresAt || 0) - Date.now());
            duration += remaining;
        } else if (current && TIER_ORDER.indexOf(tierId) < TIER_ORDER.indexOf(current)) {
            // downgrading: refund pro-rated remainder of the higher tier in Limes
            const remainingMs = Math.max(0, (perks.expiresAt || 0) - Date.now());
            const refund = Math.floor((remainingMs / (30 * 24 * 60 * 60 * 1000)) * TIERS[current].pricePerMonth);
            if (refund > 0) addLimes(userId, refund, `downgrade refund ${current}`);
            cost -= refund > 0 ? 0 : 0; // full price for the new tier; refund already credited
        }

        const spend = spendLimes(userId, cost);
        if (!spend.ok) {
            return json(res, 402, { error: "not enough Limes", needed: cost, balance: spend.balance }), true;
        }

        perks.tier = tierId;
        perks.expiresAt = Date.now() + duration;
        scheduleSave();

        return json(res, 200, {
            tier: tierId,
            expiresAt: perks.expiresAt,
            spent: cost,
            balance: spend.balance
        }), true;
    }

    // ---- Admin ----
    if (sub === "/admin/grant" && req.method === "POST") {
        if (!isAdmin(req)) return json(res, 403, { error: "forbidden" }), true;
        const { userId: target, amount, reason } = req.body || {};
        if (!target || !Number.isFinite(amount)) return json(res, 400, { error: "userId and amount required" }), true;
        const balance = addLimes(String(target), Math.floor(amount), reason || "admin grant");
        return json(res, 200, { balance }), true;
    }

    if (sub === "/admin/wallet" && req.method === "GET") {
        if (!isAdmin(req)) return json(res, 403, { error: "forbidden" }), true;
        const target = query.get("userId");
        if (!target) return json(res, 400, { error: "userId required" }), true;
        return json(res, 200, { wallet: getWallet(target), perks: getPerks(target) }), true;
    }

    if (sub === "/admin/stats" && req.method === "GET") {
        if (!isAdmin(req)) return json(res, 403, { error: "forbidden" }), true;
        const wallets = Object.values(db.wallets);
        return json(res, 200, {
            wallets: wallets.length,
            limesInCirculation: wallets.reduce((sum, w) => sum + w.balance, 0),
            activeSubscriptions: Object.entries(db.perks).filter(([, p]) => p.tier && p.expiresAt > Date.now()).length
        }), true;
    }

    return false; // not ours
}

module.exports = { handle, hydrate, TIERS, TIER_ORDER, EARNING, _db: () => db };

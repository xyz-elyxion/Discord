/*
 * Limey V1 — self-hosted ReviewDB backend
 * Mounted by server.js at /v1/reviewdb/*.
 *
 * Zero external dependencies. Data is persisted to data/reviewdb.json
 * (optionally mirrored to Redis by server.js via the kvSet/kvGet hooks).
 *
 * Endpoints (all JSON, CORS enabled):
 *   GET  /v1/reviewdb/config                       -> { clientId }  (public OAuth app id)
 *   GET  /v1/reviewdb/auth?code=...&clientMod=...  -> { token }     (OAuth2 code exchange)
 *   GET  /v1/reviewdb/users/:id/reviews            -> UserReviewsData (+ ratingsSummary, ratingCategories)
 *   GET  /v1/reviewdb/users/:id/reviews/votes      -> { votes }     (auth)
 *   PUT  /v1/reviewdb/users/:id/reviews            -> { message, reviews... } (auth)
 *   DELETE /v1/reviewdb/users/:id/reviews          -> { message }   (auth)
 *   PUT  /v1/reviewdb/reports                      -> { message }   (auth)
 *   POST /v1/reviewdb/reviews/:id/vote             -> { message }   (auth)
 *   DELETE /v1/reviewdb/reviews/:id/vote           -> { message }   (auth)
 *   PATCH /v1/reviewdb/blocks                      -> { message }   (auth)
 *   GET  /v1/reviewdb/blocks                       -> ReviewDBUser[] (auth)
 *   POST /v1/reviewdb/users                        -> ReviewDBCurrentUser (auth)
 *   PATCH /v1/reviewdb/notifications?id=           -> { ok }        (auth)
 */

"use strict";

const { readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_FILE = join(ROOT, "data", "reviewdb.json");

const DISCORD_API = "https://discord.com/api/v10";

// --- Config (env) -----------------------------------------------------------
// Uses DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET (shared with other Discord
// integrations), overridable with REVIEWDB_CLIENT_ID / REVIEWDB_CLIENT_SECRET.
// Must be a Discord OAuth2 application with the "identify" scope. The redirect
// URI must be set to https://<host>/v1/reviewdb/auth
const CLIENT_ID = process.env.REVIEWDB_CLIENT_ID || process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.REVIEWDB_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET || "";

// Optional moderation token: grants admin actions via X-Admin-Token header.
const ADMIN_TOKEN = process.env.REVIEWDB_ADMIN_TOKEN || "";

// Split rating categories — each review may rate the target on these (1-5 each).
// User profiles use the user categories, servers the server categories.
const RATING_CATEGORIES = [
    "trustworthy", "friendly", "skilled", "responsive", "creative", // user
    "active", "moderated", // server
];
const USER_RATING_CATEGORIES = RATING_CATEGORIES.slice(0, 5);
const SERVER_RATING_CATEGORIES = ["friendly", "active", "moderated"];

function sanitizeRatings(input, type = 0) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    const allowed = type === 1 ? SERVER_RATING_CATEGORIES : USER_RATING_CATEGORIES;
    const out = {};
    for (const category of allowed) {
        const value = Number(input[category]);
        if (Number.isFinite(value) && value >= 1 && value <= 5) {
            out[category] = Math.round(value);
        }
    }
    return out;
}

// Average each category across all reviews of a target (user or server id).
// type: 0 = user, 1 = server — selects which categories are allowed/summarized.
function ratingsSummaryFor(targetId, type = 0) {
    const allowed = type === 1 ? SERVER_RATING_CATEGORIES : USER_RATING_CATEGORIES;
    const sums = {};
    const counts = {};
    for (const review of db.reviews) {
        if (review.userid !== targetId || !review.ratings) continue;
        for (const [category, value] of Object.entries(review.ratings)) {
            if (!allowed.includes(category)) continue;
            sums[category] = (sums[category] ?? 0) + value;
            counts[category] = (counts[category] ?? 0) + 1;
        }
    }
    const summary = {};
    for (const category of allowed) {
        if (counts[category]) {
            summary[category] = {
                average: Math.round((sums[category] / counts[category]) * 10) / 10,
                count: counts[category],
            };
        }
    }
    return summary;
}

// --- Data store ---------------------------------------------------------------
// {
//   users:       { [discordId]: User },
//   tokens:      { [token]: discordId },
//   reviews:     Review[],
//   votes:       { [reviewId]: { [discordId]: true|false } }, // true = upvote
//   reports:     { [reviewId]: [discordId] },
//   notifications: { [discordId]: Notification },
//   optedOut:    [discordId],
//   nextReviewId: number
// }
let db = {
    users: {},
    tokens: {},
    reviews: [],
    votes: {},
    reports: {},
    notifications: {},
    optedOut: [],
    nextReviewId: 1,
};

try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    db = { ...db, ...parsed };
} catch { /* fresh database */ }

let saveTimer = null;
function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        // Redis is the primary persistence (wired by server.js); the JSON
        // file is only a local fallback and may be unavailable (read-only fs).
        if (typeof global.__reviewdbKvSet === "function") {
            global.__reviewdbKvSet("limey:reviewdb", db);
        }
        try {
            mkdirSync(join(ROOT, "data"), { recursive: true });
            writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
        } catch (err) {
            if (!global.__reviewdbKvSet) {
                console.error("[reviewdb] failed to persist data:", err.message);
            }
        }
    }, 3000);
}

// Hydrate from Redis at startup (server.js calls hydrate with the kv value).
function hydrate(value) {
    if (!value || typeof value !== "object") return;
    db = { ...db, ...value };
    console.log("[reviewdb] hydrated database from Redis");
}

// --- Helpers ------------------------------------------------------------------
function json(res, status, obj) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > 1e6) { reject(new Error("body too large")); req.destroy(); }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

function getAuth(req) {
    const header = req.headers.authorization || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const discordId = db.tokens[token];
    if (!discordId) return null;
    return { token, discordId, user: db.users[discordId] ?? null };
}

function isAdmin(req) {
    return Boolean(ADMIN_TOKEN) && (req.headers["x-admin-token"] === ADMIN_TOKEN);
}

function publicUser(user) {
    if (!user) return null;
    return {
        ID: user.ID,
        discordID: user.discordID,
        username: user.username,
        type: user.type,
        profilePhoto: user.profilePhoto,
        badges: user.badges ?? [],
    };
}

function currentUserPayload(user) {
    return {
        ...publicUser(user),
        warningCount: user.warningCount ?? 0,
        clientMod: "limeyV1",
        banInfo: user.banInfo ?? null,
        notification: db.notifications[user.discordID] ?? null,
        lastReviewID: user.lastReviewID ?? 0,
        blockedUsers: user.blockedUsers ?? [],
    };
}

// Serialize a stored review into the shape the plugin expects (entities.ts Review):
// the author must be embedded as `sender` (ReviewAuthor), not a flat field.
function serializeReview(review) {
    const senderUser = db.users[review.senderdiscordID];
    return {
        id: review.id,
        comment: review.comment,
        star: review.star ?? 0,
        timestamp: review.timestamp ?? 0,
        type: review.type ?? 0,
        ratings: review.ratings ?? {},
        senderdiscordID: review.senderdiscordID,
        sender: {
            id: senderUser?.ID ?? 0,
            discordID: review.senderdiscordID,
            username: senderUser?.username ?? "Unknown User",
            profilePhoto: senderUser?.profilePhoto ?? "",
            badges: senderUser?.badges ?? [],
        },
    };
}

function reviewsFor(discordId, { offset = 0, limit } = {}) {
    const all = db.reviews
        .filter(r => r.userid === discordId)
        .sort((a, b) => b.id - a.id);

    const total = all.length;
    const sliced = (limit ? all.slice(offset, offset + limit) : all.slice(offset))
        .map(serializeReview);

    return {
        reviews: sliced,
        reviewCount: total,
        hasNextPage: offset + sliced.length < total,
    };
}

function voteCounts(reviewId) {
    const votes = db.votes[reviewId] ?? {};
    let up = 0, down = 0;
    for (const v of Object.values(votes)) v ? up++ : down++;
    return { up, down };
}

// --- Discord OAuth2 ------------------------------------------------------------
async function exchangeCode(code) {
    if (!CLIENT_ID || !CLIENT_SECRET) {
        throw Object.assign(new Error("ReviewDB backend is not configured: set REVIEWDB_CLIENT_ID and REVIEWDB_CLIENT_SECRET"), { status: 503 });
    }

    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.REVIEWDB_REDIRECT_URI
            // Must match the redirect the plugin used to start the OAuth flow:
            // the shared /v1/oauth/callback (state=reviewdb is appended client-side).
            || "https://limey-discord.onrender.com/v1/oauth/callback",
    });

    const tokenRes = await fetch(DISCORD_API + "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        throw Object.assign(new Error(`Discord token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`), { status: 401 });
    }
    const { access_token } = await tokenRes.json();

    const meRes = await fetch(DISCORD_API + "/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!meRes.ok) {
        throw Object.assign(new Error(`Discord @me failed (${meRes.status})`), { status: 401 });
    }
    return meRes.json(); // { id, username, avatar, ... }
}

function avatarUrl(discordUser) {
    if (discordUser.avatar) {
        return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=256`;
    }
    const index = (BigInt(discordUser.id) >> 22n) % 6n;
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// --- Route handlers --------------------------------------------------------------
async function handle(req, res, url) {
    // Separate the query string before matching paths (routes never match
    // when "?code=..." is included in `path`).
    const queryIndex = url.indexOf("?");
    const query = queryIndex === -1 ? "" : url.slice(queryIndex);
    const path = url.slice("/v1/reviewdb".length, queryIndex === -1 ? undefined : queryIndex) || "/";
    const method = req.method;

    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Token"
        });
        return res.end(), true;
    }

    // Public OAuth app config so the plugin can start the OAuth flow
    if (method === "GET" && path === "/config") {
        return json(res, 200, { clientId: CLIENT_ID, configured: Boolean(CLIENT_ID && CLIENT_SECRET) }), true;
    }

    // OAuth2 code exchange -> { token }
    if (method === "GET" && path === "/auth") {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const code = params.get("code");
        if (!code) return json(res, 400, { message: "missing code parameter" }), true;

        try {
            const me = await exchangeCode(code);
            const token = crypto.randomBytes(32).toString("hex");

            db.tokens[token] = me.id;
            const existing = db.users[me.id];
            db.users[me.id] = {
                ...existing,
                ID: existing?.ID ?? Object.keys(db.users).length + 1,
                discordID: me.id,
                username: me.global_name || me.username,
                profilePhoto: avatarUrl(me),
                type: existing?.type ?? 0,
                badges: existing?.badges ?? [],
                blockedUsers: existing?.blockedUsers ?? [],
                lastReviewID: existing?.lastReviewID ?? 0,
                warningCount: existing?.warningCount ?? 0,
            };
            save();

            return json(res, 200, { token }), true;
        } catch (err) {
            return json(res, err.status ?? 500, { message: err.message }), true;
        }
    }

    // Current user info (auth)
    if (method === "POST" && path === "/users") {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        // refresh token → user binding sanity
        return json(res, 200, currentUserPayload(auth.user ?? { discordID: auth.discordId })), true;
    }

    // Read reviews (public). `type` query param: 0 = user (default), 1 = server —
    // selects which rating categories apply to the target.
    let m = /^\/users\/(\d{5,25})\/reviews$/.exec(path);
    if (method === "GET" && m) {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const offset = Number(params.get("offset") ?? 0) || 0;
        const limitRaw = Number(params.get("limit") ?? 0) || 0;
        const limit = Math.min(limitRaw || 50, 100);
        const targetType = Number(params.get("type") ?? 0) === 1 ? 1 : 0;
        const categories = targetType === 1 ? SERVER_RATING_CATEGORIES : USER_RATING_CATEGORIES;

        const { reviews, reviewCount, hasNextPage } = reviewsFor(m[1], { offset, limit });

        // Authenticated extras: user's own votes on these reviews
        const auth = getAuth(req);
        if (auth) {
            for (const review of reviews) {
                const v = db.votes[review.id]?.[auth.discordId];
                review.userVote = v === undefined ? null : v;
            }
        }

        return json(res, 200, {
            message: "Success",
            reviews,
            updated: false,
            hasNextPage,
            reviewCount,
            ratingsSummary: ratingsSummaryFor(m[1], targetType),
            ratingCategories: categories,
            hasOptedOut: db.optedOut.includes(m[1]),
        }), true;
    }

    // Votes of the current user on a target user's reviews (auth)
    m = /^\/users\/(\d{5,25})\/reviews\/votes$/.exec(path);
    if (method === "GET" && m) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        const target = db.reviews.filter(r => r.userid === m[1]);
        const votes = [];
        for (const review of target) {
            const v = db.votes[review.id]?.[auth.discordId];
            if (v !== undefined) votes.push({ reviewID: review.id, isUpvote: Boolean(v) });
        }
        return json(res, 200, { votes }), true;
    }

    // Add review (auth)
    m = /^\/users\/(\d{5,25})\/reviews$/.exec(path);
    if (method === "PUT" && m) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;
        if (db.optedOut.includes(m[1])) return json(res, 403, { message: "This user has opted out of reviews" }), true;

        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { message: "invalid JSON body" }), true;
        }

        const comment = String(body.comment ?? "").trim().slice(0, 1000);
        if (!comment) return json(res, 400, { message: "comment is required" }), true;

        const targetId = m[1];
        if (targetId === auth.discordId) return json(res, 400, { message: "You cannot review yourself" }), true;

        const sender = auth.user ?? { discordID: auth.discordId, username: "Unknown", profilePhoto: "" };
        if ((sender.warningCount ?? 0) >= 3) return json(res, 403, { message: "You are temporarily unable to add reviews" }), true;

        // one review per author per target — update instead of duplicate
        const targetType = Number(body.type ?? 0) === 1 ? 1 : 0;
        const ratings = sanitizeRatings(body.ratings, targetType);

        const existing = db.reviews.find(r => r.userid === targetId && r.senderdiscordID === auth.discordId);
        if (existing) {
            existing.comment = comment;
            existing.timestamp = Date.now();
            existing.star = Math.max(0, Math.min(5, Number(body.star ?? existing.star ?? 0)));
            existing.ratings = ratings;
            save();
            return json(res, 200, { message: "Review updated successfully" }), true;
        }

        db.reviews.push({
            id: db.nextReviewId++,
            userid: targetId,
            senderdiscordID: auth.discordId,
            comment,
            star: Math.max(0, Math.min(5, Number(body.star ?? 0))),
            ratings,
            timestamp: Date.now(),
            type: targetType,
        });
        db.users[targetId] ??= { discordID: targetId, ID: Object.keys(db.users).length + 1, type: 0, badges: [] };
        db.users[targetId].lastReviewID = db.nextReviewId - 1;
        save();

        return json(res, 200, { message: "Review added successfully" }), true;
    }

    // Delete review (auth) — author, profile owner or admin
    m = /^\/users\/(\d{5,25})\/reviews$/.exec(path);
    if (method === "DELETE" && m) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { message: "invalid JSON body" }), true;
        }
        const reviewId = Number(body.reviewid);
        const review = db.reviews.find(r => r.id === reviewId);
        if (!review) return json(res, 404, { message: "Review not found" }), true;

        const isOwner = review.senderdiscordID === auth.discordId;
        const isProfileOwner = review.userid === auth.discordId;
        const isAdminUser = auth.user?.type === 1;
        if (!isOwner && !isProfileOwner && !isAdminUser) {
            return json(res, 403, { message: "You cannot delete this review" }), true;
        }

        db.reviews = db.reviews.filter(r => r.id !== reviewId);
        delete db.votes[reviewId];
        save();
        return json(res, 200, { message: "Review deleted successfully" }), true;
    }

    // Vote (auth)
    m = /^\/reviews\/(\d+)\/vote$/.exec(path);
    if (m) {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        const reviewId = Number(m[1]);
        const review = db.reviews.find(r => r.id === reviewId);
        if (!review) return json(res, 404, { message: "Review not found" }), true;

        db.votes[reviewId] ??= {};
        if (method === "POST") {
            let body;
            try { body = JSON.parse(await readBody(req) || "{}"); } catch { body = {}; }
            db.votes[reviewId][auth.discordId] = Boolean(body.isUpvote);
            save();
            return json(res, 200, { message: "Vote registered" }), true;
        }
        if (method === "DELETE") {
            delete db.votes[reviewId][auth.discordId];
            save();
            return json(res, 200, { message: "Vote removed" }), true;
        }
    }

    // Reports (auth)
    if (method === "PUT" && path === "/reports") {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { message: "invalid JSON body" }), true;
        }
        const reviewId = Number(body.reviewid);
        if (!db.reviews.find(r => r.id === reviewId)) return json(res, 404, { message: "Review not found" }), true;

        db.reports[reviewId] ??= [];
        if (!db.reports[reviewId].includes(auth.discordId)) db.reports[reviewId].push(auth.discordId);
        save();
        return json(res, 200, { message: "Report submitted. Thank you!" }), true;
    }

    // Blocks (auth)
    if (path === "/blocks") {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        if (method === "GET") {
            const blocked = (auth.user?.blockedUsers ?? [])
                .map(id => publicUser(db.users[id]))
                .filter(Boolean);
            return json(res, 200, blocked), true;
        }

        if (method === "PATCH") {
            let body;
            try { body = JSON.parse(await readBody(req) || "{}"); } catch {
                return json(res, 400, { message: "invalid JSON body" }), true;
            }
            const action = body.action === "unblock" ? "unblock" : "block";
            const targetId = String(body.discordId ?? "");
            if (!/^\d{5,25}$/.test(targetId)) return json(res, 400, { message: "invalid discordId" }), true;

            const user = db.users[auth.discordId] ??= { discordID: auth.discordId, ID: Object.keys(db.users).length + 1, type: 0, badges: [], blockedUsers: [] };
            user.blockedUsers ??= [];

            if (action === "block" && !user.blockedUsers.includes(targetId)) user.blockedUsers.push(targetId);
            if (action === "unblock") user.blockedUsers = user.blockedUsers.filter(id => id !== targetId);
            save();

            return json(res, 200, { message: `Successfully ${action}ed user` }), true;
        }
    }

    // Read notification (auth)
    if (method === "PATCH" && path === "/notifications") {
        const auth = getAuth(req);
        if (!auth) return json(res, 401, { message: "Unauthorized" }), true;

        const params = new URLSearchParams(url.split("?")[1] ?? "");
        const id = Number(params.get("id"));
        const notif = db.notifications[auth.discordId];
        if (notif && notif.id === id) {
            delete db.notifications[auth.discordId];
            save();
        }
        return json(res, 200, { ok: true }), true;
    }

    // Admin: send notification (X-Admin-Token)
    if (isAdmin(req) && method === "POST" && path === "/admin/notify") {
        let body;
        try { body = JSON.parse(await readBody(req) || "{}"); } catch {
            return json(res, 400, { message: "invalid JSON body" }), true;
        }
        const discordId = String(body.discordId ?? "");
        if (!/^\d{5,25}$/.test(discordId)) return json(res, 400, { message: "invalid discordId" }), true;

        db.notifications[discordId] = {
            id: Date.now(),
            title: String(body.title ?? "Notification").slice(0, 100),
            content: String(body.content ?? "").slice(0, 500),
            type: Number(body.type ?? 0),
        };
        save();
        return json(res, 200, { ok: true }), true;
    }

    return json(res, 404, { message: "not found" }), true;
}

module.exports = { handle, hydrate };

/*
 * Limey V1 — Community Plugin Store backend
 * Mounted at /v1/plugins/* by server.js
 *
 * Users submit plugins (name, description, tags, author, source URL).
 * Admins approve/reject/delete them. Approved plugins appear on the
 * Plugins page under "Community" and in /v1/plugins/list.json for
 * third-party tooling.
 *
 * Persistence: in-memory + JSON file fallback + PostgreSQL via kvSet/kvGet
 * (the same pattern as the other Limey backends — server.js injects them).
 */

const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join } = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_FILE = join(ROOT, "data", "plugin-store.json");
const ADMIN_TOKEN = process.env.PLUGINSTORE_ADMIN_TOKEN || process.env.USRBG_ADMIN_TOKEN || process.env.ADMIN_TOKEN;

// How many plugins one Discord user may have pending at once
const MAX_PENDING_PER_USER = 3;
// Hard caps so the store can't be flooded
const MAX_STRING = { name: 64, description: 400, tag: 24, url: 300, author: 48 };

let kvSet = () => { };
let kvGet = async () => null;
function attachKv(setFn, getFn) {
    kvSet = setFn || kvSet;
    kvGet = getFn || kvGet;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// { approved: { id: plugin }, pending: { id: plugin } }
let store = { approved: {}, pending: {} };

function loadStore() {
    try {
        const parsed = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
        if (parsed && typeof parsed === "object") {
            store.approved = parsed.approved || {};
            store.pending = parsed.pending || {};
        }
    } catch { /* empty */ }
}
loadStore();

function saveStore() {
    void kvSet("limey:plugin-store", store);
    try {
        mkdirSync(join(ROOT, "data"), { recursive: true });
        writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
        console.error("[pluginstore] failed to save:", err.message);
    }
}

function hydrate(data) {
    if (!data || typeof data !== "object") return;
    if (typeof data.approved === "object" && data.approved) store.approved = data.approved;
    if (typeof data.pending === "object" && data.pending) store.pending = data.pending;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanStr(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// plugin ids are url-safe slugs derived from the name
function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "plugin";
}

function publicPlugin(p) {
    // everything except internal fields
    const { submittedBy, ...rest } = p;
    return rest;
}

// ---------------------------------------------------------------------------
// Submission validation
// ---------------------------------------------------------------------------

function validateSubmission(body) {
    const errors = [];
    const name = cleanStr(body.name, MAX_STRING.name);
    const description = cleanStr(body.description, MAX_STRING.description);
    const sourceUrl = cleanStr(body.sourceUrl, MAX_STRING.url);
    const authorName = cleanStr(body.authorName, MAX_STRING.author);
    const authorId = cleanStr(body.authorId, 20);
    const tags = Array.isArray(body.tags)
        ? body.tags.slice(0, 5).map(t => cleanStr(t, MAX_STRING.tag)).filter(Boolean)
        : [];
    const hasCommands = !!body.hasCommands;
    const hasPatches = !!body.hasPatches;

    if (!name || name.length < 3) errors.push("Plugin name must be at least 3 characters.");
    if (!description || description.length < 10) errors.push("Description must be at least 10 characters.");
    if (!/^https:\/\/(github\.com|gitlab\.com|git\.)\/?/i.test(sourceUrl)) errors.push("Source URL must be a https:// github.com or gitlab.com link.");
    if (!authorId || !/^\d{5,20}$/.test(authorId)) errors.push("A valid Discord user ID is required.");
    if (!authorName) errors.push("Author name is required.");

    return {
        errors,
        value: {
            name,
            description,
            sourceUrl,
            tags,
            hasCommands,
            hasPatches,
            author: { name: authorName, id: authorId },
            submittedBy: authorId
        }
    };
}

// ---------------------------------------------------------------------------
// HTTP handling
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req, limit = 1e6) {
    return new Promise((resolveBody, reject) => {
        let body = "";
        req.on("data", chunk => {
            body += chunk;
            if (body.length > limit) {
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => resolveBody(body));
        req.on("error", reject);
    });
}

// Admin auth: X-Admin-Token header, same token as the rest of the site
function isAdmin(req) {
    const token = req.headers["x-admin-token"] || "";
    return !!ADMIN_TOKEN && typeof token === "string" && token === ADMIN_TOKEN;
}

async function handle(req, res, url) {
    const method = req.method || "GET";

    // CORS preflight for the submit endpoint
    if (method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token"
        });
        return res.end(), true;
    }

    // GET /v1/plugins/list.json — approved plugins, publicly fetchable
    if (method === "GET" && (url === "/v1/plugins/list.json" || url === "/v1/plugins/list")) {
        const list = Object.values(store.approved)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(publicPlugin);
        return send(res, 200, { plugins: list }), true;
    }

    // GET /v1/plugins/pending — admin only
    if (method === "GET" && url === "/v1/plugins/pending") {
        if (!isAdmin(req)) return send(res, 403, { error: "Forbidden" }), true;
        const list = Object.values(store.pending)
            .sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
        return send(res, 200, { plugins: list }), true;
    }

    // POST /v1/plugins/submit — public submission
    if (method === "POST" && url === "/v1/plugins/submit") {
        let body;
        try { body = JSON.parse((await readBody(req)) || "{}"); } catch {
            return send(res, 400, { error: "Invalid JSON body." }), true;
        }

        const { errors, value } = validateSubmission(body);
        if (errors.length) return send(res, 400, { errors }), true;

        // Cap pending submissions per user
        const mine = Object.values(store.pending).filter(p => p.submittedBy === value.submittedBy);
        if (mine.length >= MAX_PENDING_PER_USER) {
            return send(res, 429, { error: `You already have ${MAX_PENDING_PER_USER} plugins pending review. Wait for one to be approved or rejected first.` }), true;
        }

        const id = slugify(value.name);
        if (store.approved[id] || store.pending[id]) {
            return send(res, 409, { error: `A plugin with a similar name already exists (id: ${id}).` }), true;
        }

        const plugin = {
            ...value,
            id,
            submittedAt: new Date().toISOString(),
            approved: false
        };
        store.pending[id] = plugin;
        saveStore();
        console.log(`[pluginstore] submitted: ${id} by ${value.author.name} (${value.author.id})`);
        return send(res, 201, { ok: true, id, message: "Submitted! It will appear in the store once an admin approves it." }), true;
    }

    // POST /v1/plugins/:id/approve | /reject | /delete — admin actions
    const adminMatch = url.match(/^\/v1\/plugins\/([a-z0-9-]+)\/(approve|reject|delete)$/);
    if (method === "POST" && adminMatch) {
        if (!isAdmin(req)) return send(res, 403, { error: "Forbidden" }), true;
        const [, id, action] = adminMatch;

        if (action === "approve") {
            const plugin = store.pending[id];
            if (!plugin) return send(res, 404, { error: "No pending plugin with that id." }), true;
            delete store.pending[id];
            plugin.approved = true;
            plugin.approvedAt = new Date().toISOString();
            store.approved[id] = plugin;
            saveStore();
            console.log(`[pluginstore] approved: ${id}`);
            return send(res, 200, { ok: true, id }), true;
        }

        if (action === "reject") {
            if (!store.pending[id]) return send(res, 404, { error: "No pending plugin with that id." }), true;
            delete store.pending[id];
            saveStore();
            console.log(`[pluginstore] rejected: ${id}`);
            return send(res, 200, { ok: true, id }), true;
        }

        if (action === "delete") {
            if (!store.approved[id]) return send(res, 404, { error: "No approved plugin with that id." }), true;
            delete store.approved[id];
            saveStore();
            console.log(`[pluginstore] deleted: ${id}`);
            return send(res, 200, { ok: true, id }), true;
        }
    }

    return false;
}

module.exports = { handle, hydrate, attachKv, _db: () => store, slugify, validateSubmission };

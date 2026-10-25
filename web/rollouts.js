/*
 * Limey V1 — deployment / rollout strategy engine (docs §4).
 *
 * Every row of /docs/release-channels#4-deployment--rollout-strategies is
 * backed by real serving behavior here. The engine decides, per stable-file
 * request, WHICH dist copy answers: the current build (blue / "current"), the
 * frozen previous copy (green / "staged back-stop"), or the canary snapshot.
 * Cohorts are decided by a deterministic bucket of a client key so a client
 * always lands in the same cohort across requests and restarts.
 *
 * State lives in KV (PostgreSQL) + an in-memory mirror; admin endpoints in
 * server.js write through here. Strategies:
 *
 *   full           everyone gets the current build (the historical default)
 *   rolling        same serving behavior as full, framed as continuous delivery
 *   canary-rollout a fixed percentage cohort rides the canary snapshot
 *   progressive    staged cohorts: bucket < stagePercent → current, else previous
 *   phased         like progressive but percent comes from calendar windows
 *   bluegreen      explicit blue/green pointer over current vs frozen previous
 *   shadow         a small diagnostic cohort rides the new build under an
 *                  X-Limey-Shadow header while everyone else stays put
 *   featureflagged file serving unaffected; per-cohort flags on /v1/featureflags
 *   abtest         per-slug variant assignment on /v1/abtest
 *
 * Cohort key: `?installId=` (sanitized) if the client supplies one, else the
 * first hop of X-Forwarded-For, else the socket address. Never signed — good
 * enough for serving cohorts, not an identity system.
 */

"use strict";

const { createHash } = require("crypto");
const { join } = require("path");

const CURRENT_SCHEMA = "limey.v1/rollouts/1";
const STATE_KV_KEY = "limey:rollout-state";

const STRATEGIES = [
    "full", "rolling", "canary-rollout", "progressive", "phased",
    "bluegreen", "shadow", "featureflagged", "abtest"
];

let ctx = {
    DIST: null,
    kvGet: null, // async (key) -> value|null
    kvSet: null, // (key, value) -> void
    log: () => {}
};

// in-memory mirror of the persisted state (single-process server)
let state = null;
// counters — per process, never persisted (cheap + informative in /v1/rollouts)
let stats = {
    full: 0, rolling: 0, canary: 0, current: 0, previous: 0, green: 0,
    blue: 0, shadow: 0, flagsResolved: 0, abtestResolved: 0
};

function sanitizeInstallId(raw) {
    if (typeof raw !== "string") return null;
    const value = raw.trim();
    return /^[\w-]{1,64}$/.test(value) ? value : null;
}

/** Deterministic cohort bucket 0..99 for a client key. */
function bucketOf(clientKey) {
    const hex = createHash("sha256").update(`limey-rollout:${clientKey}`).digest("hex");
    // first 4 bytes → 0..9999 → 0..99.99 rounded to 0..99 integer per-mille style
    return Math.floor(parseInt(hex.slice(0, 8), 16) / 4294967296 * 100) % 100;
}

/** Build the cohort key for a request. `query` may carry installId. */
function clientKeyFor(req, query, socketAddr) {
    const installId = sanitizeInstallId(query?.installId);
    if (installId) return "install:" + installId;
    const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return "ip:" + xff;
    if (socketAddr) return "ip:" + socketAddr;
    return "anon";
}

function hasPreviousCopy() {
    if (!ctx.DIST) return false;
    try { return require("fs").existsSync(join(ctx.DIST, "previous", "patcher.js")); } catch { return false; }
}

function canaryCopyPublished() {
    if (!ctx.DIST) return false;
    try { return require("fs").existsSync(join(ctx.DIST, "canary", "patcher.js")); } catch { return false; }
}

/** percent for `progressive`-family strategies at the moment of a request. */
function stagedPercent() {
    if (state.strategy === "phased") {
        const now = Date.now();
        let percent = 0;
        for (const phase of state.phases) {
            const at = Date.parse(phase.at);
            if (!Number.isNaN(at) && at <= now && phase.percent >= percent) percent = phase.percent;
        }
        return percent;
    }
    return state.stagePercent;
}

/**
 * Which dist directory answers a stable build request.
 * Returns { dir, mode, isShadow } — mode is one of
 * full | rolling | canary | staged-current | staged-previous | shadow | green | blue.
 */
function resolveServing(clientKey) {
    const DIST = ctx.DIST;
    if (!DIST || state.strategy === "full") {
        return { dir: DIST, mode: "full", isShadow: false };
    }

    const bucket = bucketOf(clientKey);

    switch (state.strategy) {
        case "rolling":
            return { dir: DIST, mode: "rolling", isShadow: false };

        case "canary-rollout": {
            // Only cohorts under the percentage ride canary; the rest stay on
            // stable. Canaries that aren't frozen fall back to stable files.
            if (state.canaryPercent > 0 && canaryCopyPublished() && bucket < state.canaryPercent) {
                return { dir: join(DIST, "canary"), mode: "canary", isShadow: false };
            }
            return { dir: DIST, mode: "full", isShadow: false };
        }

        case "progressive":
        case "phased": {
            const percent = stagedPercent();
            if (percent >= 100) return { dir: DIST, mode: "full", isShadow: false };
            if (percent <= 0) return { dir: DIST, mode: "full", isShadow: false };
            const current = bucket < percent;
            if (current || !hasPreviousCopy()) return { dir: DIST, mode: "staged-current", isShadow: false };
            return { dir: join(DIST, "previous"), mode: "staged-previous", isShadow: false };
        }

        case "bluegreen":
            if (state.serve === "green" && hasPreviousCopy()) return { dir: join(DIST, "previous"), mode: "green", isShadow: false };
            return { dir: DIST, mode: "blue", isShadow: false };

        case "shadow": {
            // Shadow ring: a tiny cohort rides the new build while everyone
            // else stays frozen. Needs both copies; otherwise behave as full.
            if (!hasPreviousCopy()) return { dir: DIST, mode: "full", isShadow: false };
            if (bucket < state.shadowPercent) return { dir: DIST, mode: "shadow", isShadow: true };
            return { dir: join(DIST, "previous"), mode: "staged-previous", isShadow: false };
        }

        // File serving ignores flag / abtest strategies (their surface is
        // /v1/featureflags and /v1/abtest).
        case "featureflagged":
        case "abtest":
            return { dir: DIST, mode: "full", isShadow: false };

        default:
            return { dir: DIST, mode: "full", isShadow: false };
    }
}

function recordServing(mode, isShadow) {
    if (isShadow) stats.shadow++;
    if (mode === "full") stats.full++;
    else if (mode === "rolling") stats.rolling++;
    else if (mode === "canary") stats.canary++;
    else if (mode === "green") stats.green++;
    else if (mode === "blue") stats.blue++;
    else if (mode === "staged-current" || mode === "shadow") stats.current++;
    else if (mode === "staged-previous") stats.previous++;
}

function activePhase(percent) {
    if (state.strategy !== "phased") return null;
    const now = Date.now();
    let activating = null;
    for (const phase of state.phases) {
        const at = Date.parse(phase.at);
        if (!Number.isNaN(at) && at <= now && (!activating || Date.parse(phase.at) > Date.parse(activating.at))) activating = phase;
    }
    return activating ? { ...activating, percent } : null;
}

/** Public (non-secret) summary for /v1/rollouts and the channels manifest. */
function publicStatus() {
    return {
        schema: CURRENT_SCHEMA,
        strategy: state.strategy,
        docsUrl: "https://limey-discord.onrender.com/docs/release-channels#4-deployment--rollout-strategies",
        rolling: state.strategy === "rolling",
        canaryRollout: state.strategy === "canary-rollout"
            ? { percent: state.canaryPercent, canaryPublished: canaryCopyPublished() }
            : null,
        progressive: state.strategy === "progressive"
            ? { stagePercent: state.stagePercent, previousCopyReady: hasPreviousCopy(), previousHash: state.previousHash }
            : null,
        phased: state.strategy === "phased"
            ? { percent: stagedPercent(), activePhase: activePhase(stagedPercent()), phases: state.phases, previousCopyReady: hasPreviousCopy() }
            : null,
        bluegreen: state.strategy === "bluegreen"
            ? { serve: state.serve, previousCopyReady: hasPreviousCopy(), previousHash: state.previousHash }
            : null,
        shadow: state.strategy === "shadow"
            ? { percent: state.shadowPercent, previousCopyReady: hasPreviousCopy(), previousHash: state.previousHash }
            : null,
        featureflagged: state.strategy === "featureflagged"
            ? { flagCount: Object.keys(state.flags).length }
            : null,
        abtest: state.strategy === "abtest"
            ? { experimentCount: Object.keys(state.abtests).length }
            : null,
        stats
    };
}

/* ------------------------------------------------------------------ */
/* Validation + admin writes                                          */
/* ------------------------------------------------------------------ */

function assertStrategy(value) {
    if (!STRATEGIES.includes(value)) throw new Error("strategy must be one of " + STRATEGIES.join("|"));
    if ((value === "canary-rollout" || value === "progressive" || value === "phased" || value === "bluegreen" || value === "shadow") && !ctx.DIST) {
        throw new Error("engine not ready");
    }
}

async function setStrategy(strategy) {
    assertStrategy(strategy);
    const specials = ["progressive", "phased", "bluegreen", "shadow"];
    state.strategy = strategy;
    // Starting a staged-family strategy with no frozen previous copy means the
    // whole population immediately rides the new build; surface that loudly.
    if (specials.includes(strategy) && !hasPreviousCopy()) {
        ctx.log(`[rollouts] strategy ${strategy} active with no dist/previous snapshot — all clients get the current build`);
    }
    await persist();
}

async function setCanaryPercent(percent) {
    percent = Math.max(0, Math.min(100, Number(percent) | 0));
    state.canaryPercent = percent;
    state.strategy = "canary-rollout";
    await persist();
}

async function setStagePercent(percent) {
    percent = Math.max(0, Math.min(100, Number(percent) | 0));
    state.stagePercent = percent;
    state.strategy = "progressive";
    await persist();
}

async function setPhases(phases) {
    if (!Array.isArray(phases)) throw new Error("phases must be an array of {at, percent, name?}");
    state.phases = phases
        .map(p => ({
            at: String(p.at ?? ""),
            percent: Math.max(0, Math.min(100, Number(p.percent) | 0)),
            name: typeof p.name === "string" ? p.name.slice(0, 64) : undefined
        }))
        .filter(p => !Number.isNaN(Date.parse(p.at)));
    if (!state.phases.length) throw new Error("phases needs at least one { at, percent } window");
    state.strategy = "phased";
    await persist();
}

async function setShadowPercent(percent) {
    percent = Math.max(0, Math.min(100, Number(percent) | 0));
    state.shadowPercent = percent;
    state.strategy = "shadow";
    await persist();
}

async function setServe(side) {
    if (side !== "blue" && side !== "green") throw new Error("serve must be blue|green");
    state.serve = side;
    state.strategy = "bluegreen";
    await persist();
}

async function notePreviousCopy(hash) {
    state.previousHash = hash ?? null;
    await persist();
}

async function setFlags(flags) {
    if (!flags || typeof flags !== "object" || Array.isArray(flags)) throw new Error("flags must be an object");
    const clean = {};
    for (const [name, value] of Object.entries(flags)) {
        if (!/^\w{1,64}$/.test(name)) throw new Error("flag names must be \\w{1,64}: " + name);
        clean[name] = typeof value === "object" && value !== null
            ? { enabled: Boolean(value.enabled), percent: Math.max(0, Math.min(100, Number(value.percent) | 0)) }
            : { enabled: Boolean(value), percent: 100 };
    }
    state.flags = clean;
    state.strategy = "featureflagged";
    await persist();
}

async function setAbtests(slug, variants, percent) {
    if (typeof slug !== "string" || !/^\w{1,32}$/.test(slug)) throw new Error("slug must be a word");
    if (!Array.isArray(variants) || variants.length < 2 || !variants.every(v => typeof v === "string" && v.length <= 32)) {
        throw new Error("variants needs 2+ short names");
    }
    state.abtests[slug] = { variants, percent: Math.max(0, Math.min(100, Number(percent) | 0)) };
    state.strategy = "abtest";
    await persist();
}

/** Flag resolution for a cohort — used by /v1/featureflags. */
function resolveFlags(clientKey) {
    const bucket = bucketOf(clientKey);
    const out = {};
    for (const [name, flag] of Object.entries(state.flags)) {
        out[name] = flag.enabled && bucket < flag.percent;
    }
    stats.flagsResolved++;
    return out;
}

/** Which variant a client gets for an experiment — /v1/abtest. */
function abtestVariant(slug, clientKey) {
    const experiment = state.abtests[slug];
    if (!experiment) return null;
    const bucket = bucketOf(clientKey);
    if (bucket >= experiment.percent) return { variant: experiment.variants[0], inExperiment: false, bucket };
    const span = experiment.variants.length;
    const variant = experiment.variants[Math.floor(bucket * span / 100) % span];
    stats.abtestResolved++;
    return { variant, inExperiment: true, bucket };
}

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */

async function persist() {
    try {
        if (ctx.kvSet) await ctx.kvSet(STATE_KV_KEY, state);
    } catch (err) {
        ctx.log(`[rollouts] persist failed: ${err && err.message}`);
    }
}

async function init({ DIST, kvGet, kvSet, log }) {
    ctx = { DIST, kvGet, kvSet, log: log ?? (msg => console.log(msg)) };
    state = {
        strategy: "full",
        canaryPercent: 0,
        stagePercent: 100,
        phases: [],
        shadowPercent: 1,
        serve: "blue",
        flags: {},
        abtests: {},
        previousHash: null
    };
    try {
        let stored = await kvGet(STATE_KV_KEY);
        if (typeof stored === "string" && stored.startsWith("{")) stored = JSON.parse(stored);
        if (stored && typeof stored === "object" && STRATEGIES.includes(stored.strategy)) {
            state = { ...state, ...stored };
            if (typeof state.stagePercent !== "number") state.stagePercent = 100;
            if (typeof state.canaryPercent !== "number") state.canaryPercent = 0;
            if (typeof state.shadowPercent !== "number") state.shadowPercent = 1;
            if (!Array.isArray(state.phases)) state.phases = [];
            if (typeof state.flags !== "object" || !state.flags) state.flags = {};
            if (typeof state.abtests !== "object" || !state.abtests) state.abtests = {};
        }
    } catch (err) {
        ctx.log(`[rollouts] state load failed (${err && err.message}) — starting fresh`);
    }
    return state;
}

module.exports = {
    STRATEGIES,
    CURRENT_SCHEMA,
    init,
    persist,
    publicStatus,
    clientKeyFor,
    bucketOf,
    resolveServing,
    recordServing,
    setStrategy,
    setCanaryPercent,
    setStagePercent,
    setPhases,
    setShadowPercent,
    setServe,
    setFlags,
    setAbtests,
    notePreviousCopy,
    resolveFlags,
    abtestVariant,
    hasPreviousCopy,
    canaryCopyPublished,
    // test hooks
    _state: () => state
};

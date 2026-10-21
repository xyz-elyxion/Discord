/*
 * Limey V1 Release Channels — server-side channel registry.
 *
 * Single source of truth for the channel manifest served at GET
 * /v1/channels. Modeled directly on the "Release Channels" docs page
 * (docs-site/src/content/docs/release-channels.mdx): every entry is tagged
 * with its origin and implemented flag so no consumer can mistake a
 * proposed label for a channel that actually ships builds.
 *
 * IMPORTANT: keep this data in sync with src/utils/releaseChannels.ts
 * (the client-side copy bundled into the renderer — the desktop updater
 * settings section reads it offline, since it must render without a
 * backend round-trip).
 *
 * NO URLs, branches or update feeds are listed here for `implemented:
 * false` entries — proposed channels are definitions, not artifacts.
 */

"use strict";

const CURRENT_SCHEMA = "limey.v1/channels/1";

/** Files a frozen snapshot channel contains — same set the Go installer
 * downloads (installer/constants.go BuildFiles) and the admin panel copies. */
const SNAPSHOT_ARTIFACTS = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];

/** The shipped artifact tracks: stable + dev come from the build
 * pipeline, everything else is a snapshot channel frozen into
 * dist/<channel>/ from the backend's current build (see
 * scripts/publishChannel.mjs and the admin panel's freeze tab). */
const CHANNELS = [
    // -----------------------------------------------------------------
    // Tracks — which Limey V1 code you run
    // -----------------------------------------------------------------
    {
        id: "stable",
        name: "Stable",
        category: "track",
        origin: "limey",
        stability: "production",
        cadence: "per release",
        audience: "everyone",
        description: "Default, reviewed track. Builds are hash-stamped and served by the installer; changes get a changelog entry.",
        implemented: true,
        artifacts: ["limeyV1DesktopMain.js", "limeyV1DesktopPreload.js", "limeyV1DesktopRenderer.js", "limeyV1DesktopRenderer.css"]
    },
    {
        id: "dev",
        name: "Development (DevBuild)",
        category: "track",
        origin: "limey",
        stability: "unstable",
        cadence: "per commit (git updater)",
        audience: "developers and contributors",
        description: "Source-built flavor. Self-identifies as a DevBuild (support warning, git updater active) instead of pretending to be a release.",
        implemented: true,
        artifacts: []
    },
    {
        id: "devbuild",
        name: "DevBuild",
        category: "track",
        origin: "limey",
        stability: "unstable",
        cadence: "= dev",
        audience: "alias of dev",
        description: "Runtime label of a dev build. Kept as an alias so existing 'Am I on a DevBuild?' checks keep working.",
        implemented: false,
        aliases: ["dev"]
    },
    {
        id: "rc", name: "Release Candidate", category: "track", origin: "proposed",
        stability: "testing", cadence: "one per release cycle", audience: "testers pre-validating",
        description: "Feature-complete pre-release of the next stable version; folded into stable once clean. Published to dist/rc/ per release cycle; between cycles the channel has no build and reports not-published.",
        implemented: true, artifacts: ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
    },
    {
        id: "beta", name: "Beta", category: "track", origin: "proposed",
        stability: "testing", cadence: "per feature batch", audience: "curious early adopters",
        description: "Public pre-release accumulating features for the next version. Published to dist/beta/ per feature batch; between batches the channel has no build and reports not-published.",
        implemented: true, artifacts: ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
    },
    {
        id: "preview", name: "Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "with each dev batch", audience: "non-technical early adopters",
        description: "Friendly umbrella label for the pre-release family (rc/beta); UI alias, not an installable channel.",
        implemented: false,
        aliases: ["beta", "rc"]
    },
    {
        id: "alpha", name: "Alpha", category: "track", origin: "proposed",
        stability: "unstable", cadence: "per feature batch, before beta", audience: "plugin developers porting early",
        description: "Earliest shipped pre-release: code that will change shape, frozen per fresh feature batch. Installed from dist/alpha/ with the installer's --channel alpha; unpublished batches answer not-published.",
        implemented: true, artifacts: ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
    },
    {
        id: "canary", name: "Canary (Limey)", category: "track", origin: "limey",
        stability: "unstable", cadence: "per batch, freshest shipped pre-release", audience: "adventurous testers",
        description: "Freshest shipped pre-release of the next version, refrozen per batch ahead of beta. Not to be confused with the discord-canary host channel, which is Discord's client branch. Install with --channel canary; unpublished batches answer not-published.",
        implemented: true, artifacts: ["patcher.js", "preload.js", "renderer.js", "renderer.css"]
    },
    {
        id: "nightly", name: "Nightly", category: "track", origin: "proposed",
        stability: "unstable", cadence: "daily cron of main", audience: "automated cross-testing",
        description: "Scheduled snapshot of the main branch, built automatically even if commits are broken. Frozen per nightly cron run; unpublished windows answer not-published.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen per nightly cron (or admin publish)."
    },
    {
        id: "edge", name: "Edge", category: "track", origin: "proposed",
        stability: "volatile", cadence: "per push", audience: "CI systems",
        description: "Purest freshness: same-source as nightly but built per successful push, no schedule. Expect arbitrary machine state.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen per successful push (or admin publish)."
    },
    {
        id: "debug", name: "Debug", category: "track", origin: "proposed",
        stability: "internal", cadence: "on demand", audience: "core developers",
        description: "Verbose-logging diagnostic build (sourcemaps, devtools unwrap, integrity checks off). Not meant to leave the build machine.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen on demand for support requests."
    },
    {
        id: "custom", name: "Custom Build", category: "track", origin: "proposed",
        stability: "volatile", cadence: "owner-driven", audience: "fork maintainers",
        description: "A user-built flavor from a fork with extra patches, distinct branding or plugin changes. Owner-driven — the fork maintainer knows who's authoritative.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen from the fork's own build output."
    },
    {
        id: "snapshot", name: "Snapshot", category: "track", origin: "proposed",
        stability: "unstable", cadence: "manual or test-gated", audience: "plugin CI",
        description: "Point-in-time named dev build. vs nightly: snapshot inclusion is manual or gated on tests, nightly is a cron.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen on demand per snapshot batch."
    },
    {
        id: "experimental", name: "Experimental", category: "track", origin: "proposed",
        stability: "volatile", cadence: "with the experiments", audience: "plugin authors opting into flags",
        description: "Aggregates exceptional opt-in functionality (feature-flagged plugins, rewrites) pinned to a stable-ish base.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Frozen whenever an experiment lands."
    },
    {
        id: "early", name: "Early Access", category: "track", origin: "proposed",
        stability: "testing", cadence: "same as beta/rc", audience: "perk-tier subscribers",
        description: "Logged-in users get the next feature batch a little earlier, built from rc-quality code.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Optional perk for perk-tier subscribers."
    },
    {
        id: "insider", name: "Insider", category: "track", origin: "proposed",
        stability: "testing", cadence: "batch-shaped", audience: "users who want the why",
        description: "Same artifacts as beta but packaged as a 'read the dev diary' crowd with per-batch release notes.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Same artifact as beta; choose by UX taste."
    },
    {
        id: "preview-ch", name: "Preview Channel", category: "track", origin: "proposed",
        stability: "testing", cadence: "same as beta", audience: "same as beta",
        description: "A friendlier folded display name for the beta stream, kept so the settings menu can say 'Preview (Beta)'.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Pure naming fallback — another name users search for."
    },
    {
        id: "dev-preview", name: "Developer Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "per planned release milestone", audience: "plugin ecosystem maintainers",
        description: "Spec-stable subset of the upcoming release — API changes, plugin manifest schema and patch points the plugin ecosystem depends on, frozen per milestone.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "API-frozen per planned milestone."
    },
    {
        id: "internal", name: "Internal Testing", category: "track", origin: "proposed",
        stability: "internal", cadence: "irregular", audience: "core collaborators",
        description: "Small ring for core collaborators before anything public: internal checksums, unreleased heuristics, security-sensitive fixes.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Round-0 verification of an upcoming security patch."
    },
    {
        id: "community", name: "Community Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "community-driven", audience: "plugin community, store authors",
        description: "Public 'vote on what's next' lobe where the top-voted candidate experiments advance to beta.",
        implemented: true, artifacts: SNAPSHOT_ARTIFACTS, note: "Top-voted candidates advance to beta."
    },

    // -----------------------------------------------------------------
    // Hosts — which Discord branch / browser it runs in (install targets)
    // -----------------------------------------------------------------
    { id: "discord-stable", name: "Discord Stable", category: "host", origin: "discord", stability: "production", cadence: "Discord-driven", audience: "everyone", description: "Mainstream Discord desktop app. Default install target of the installer.", implemented: true },
    { id: "discord-ptb", name: "Discord PTB", category: "host", origin: "discord", stability: "testing", cadence: "Discord-driven, before wide release", audience: "opt-in testers", description: "Discord's wide pre-stable client branch. Detected and supported by the installer.", implemented: true },
    { id: "discord-canary", name: "Discord Canary", category: "host", origin: "discord", stability: "unstable", cadence: "near daily, from Discord", audience: "client-mod developers", description: "Discord's fastest-moving client branch; catches patch-target drift early.", implemented: true },
    { id: "discord-development", name: "Discord Development", category: "host", origin: "discord", stability: "volatile", cadence: "erratic, from Discord", audience: "Discord staff and client mod devs", description: "Discord's internal-flavor branch, occasionally distributed.", implemented: true },
    { id: "web", name: "Web Client (browser)", category: "host", origin: "limey", stability: "production", cadence: "per stable release", audience: "browser-first users", description: "Chrome MV3 extension, Firefox shell and userscripts for discord.com.", implemented: true },
    { id: "custom-client", name: "Custom Client Build", category: "host", origin: "proposed", stability: "volatile", cadence: "owner-driven", audience: "fork operators", description: "Third-party Discord-compatible clients; best-effort, unsupported.", implemented: false },

    // -----------------------------------------------------------------
    // Rollout strategies — how the next build reaches users
    // -----------------------------------------------------------------
    { id: "full", name: "Immediate (Full rollout)", category: "rollout", origin: "limey", stability: "production", cadence: "per release", audience: "everyone", description: "Newest served to everyone as soon as the hash flips. Current behavior.", implemented: true },
    { id: "canary-rollout", name: "Canary Rollout", category: "rollout", origin: "proposed", stability: "production (early cohort)", cadence: "per release, percentage-driven", audience: "volunteers", description: "Ship first to a tiny percentage of volunteers before the broader audience. Note: distinct from the canary track, which is a shipped pre-release build, and from the Discord canary host branch.", implemented: false },
    { id: "progressive", name: "Progressive Rollout", category: "rollout", origin: "proposed", stability: "production", cadence: "cohort gates", audience: "everyone, spread over time", description: "1% → 10% → 50% → 100% cohorts, each gated on error telemetry.", implemented: false },
    { id: "featureflagged", name: "Feature-Flagged Release", category: "rollout", origin: "proposed", stability: "production", cadence: "continuous, no reinstall", audience: "everyone", description: "Ship disabled features to stable, enable them remotely per user/cohort.", implemented: false },
    { id: "rollback", name: "Rollback", category: "rollout", origin: "proposed", stability: "production", cadence: "emergency only", audience: "users being protected", description: "Re-point users to the last known good hash after a bad release.", implemented: false },

    // -----------------------------------------------------------------
    // Maintenance states a track can enter
    // -----------------------------------------------------------------
    { id: "hotfix", name: "Hotfix", category: "maintenance", origin: "proposed", stability: "production", cadence: "as needed", audience: "everyone (fast-tracked)", description: "Out-of-band patch bypassing normal gates because the live product is broken.", implemented: false },
    { id: "security-patch", name: "Security Patch", category: "maintenance", origin: "proposed", stability: "production", cadence: "as vulnerabilities are found", audience: "everyone", description: "Hotfix with silent deploy priority; reaches stable before a changelog is cut.", implemented: false },
    { id: "legacy", name: "Legacy", category: "maintenance", origin: "proposed", stability: "testing (frozen)", cadence: "rare", audience: "users on old Discord versions", description: "Old client-version-limited builds kept around with explicit support dates.", implemented: false },
    { id: "deprecated", name: "Deprecated", category: "maintenance", origin: "vencord", stability: "any", cadence: "until removal", audience: "everyone", description: "Scheduled for removal; updater nags with a transition link. Real for plugins upstream, proposed for tracks.", implemented: false },
    { id: "lts", name: "Stable LTS", category: "maintenance", origin: "limey", stability: "production", cadence: "security/crash fixes only", audience: "downtime-sensitive setups", description: "Frozen stable snapshot with a long support window. Served from the backend's dist/lts/ snapshot; until the first pin is published it tracks the current stable build. Install with the installer's --channel lts.", implemented: true, artifacts: ["patcher.js", "preload.js", "renderer.js", "renderer.css"] },
    { id: "archived", name: "Archived", category: "maintenance", origin: "proposed", stability: "frozen", cadence: "never updates", audience: "historians, forensics", description: "Read-only snapshots; inspectable, not installable.", implemented: false }
];

const CATEGORY_ORDER = ["track", "host", "rollout", "maintenance"];

/** Self-contained JSON responder (same CORS policy as the other in-process backends). */
function sendJson(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(body));
}

/** The served manifest — schema-versioned so consumers can reject shapes they don't know. */
function manifest() {
    return {
        schema: CURRENT_SCHEMA,
        strategy: "full", // current rollout strategy (immediate hash-flip)
        implementedOnly: Object.fromEntries(CATEGORY_ORDER.map(c => [c, CHANNELS.filter(ch => ch.category === c && ch.implemented).map(ch => ch.id)])),
        channels: CHANNELS
    };
}

/**
 * GET /v1/channels      -> full manifest
 * GET /v1/channels.json -> same manifest, explicit extension
 * GET /v1/channels/:id  -> single channel (404 when unknown)
 * Returns false for anything else so server.js keeps dispatching.
 */
function handle(req, res, url) {
    if (url === "/v1/channels" || url === "/v1/channels.json") {
        return sendJson(res, 200, manifest()), true;
    }
    const single = /^\/v1\/channels\/([a-z0-9-]+)$/.exec(url);
    if (single) {
        const channel = CHANNELS.find(ch => ch.id === single[1]);
        if (!channel) return sendJson(res, 404, { error: "unknown channel", id: single[1] }), true;
        return sendJson(res, 200, { schema: CURRENT_SCHEMA, channel }), true;
    }
    return false;
}

module.exports = {
    handle,
    manifest,
    CHANNELS,
    CURRENT_SCHEMA
};

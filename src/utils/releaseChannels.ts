/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Release Channels — client-side registry and track detection.
 *
 * Mirrors the server manifest served at /v1/channels
 * (release-channels.js) and the docs page
 * limey-discord.onrender.com/docs/release-channels. The client keeps a
 * local copy so the settings UI can render offline — keep the two in
 * sync, keyed by channel id + schema fields.
 *
 * Accuracy rules (same as the docs page):
 *  - `implemented: true` only for channels that actually ship artifacts
 *    today; proposed labels are definitions, never fake download feeds.
 *  - Discord Stable/PTB/Canary/Development are Discord's own client
 *    branches (install targets), NOT Limey V1 build channels.
 */

export type ChannelOrigin = "limey" | "vencord" | "discord" | "discord-process" | "proposed";
export type ChannelCategory = "track" | "host" | "rollout" | "maintenance";
/** Matches the stability scale on the docs page. */
export type ChannelStability = "production" | "testing" | "unstable" | "volatile" | "internal";

export interface ReleaseChannel {
    id: string;
    name: string;
    category: ChannelCategory;
    origin: ChannelOrigin;
    stability: ChannelStability;
    cadence: string;
    audience: string;
    description: string;
    implemented: boolean;
    aliases?: string[];
}

export const RELEASE_CHANNELS_SCHEMA = "limey.v1/channels/1";

export const RELEASE_CHANNELS: ReleaseChannel[] = [
    // ---------------- Tracks ----------------
    {
        id: "stable", name: "Stable", category: "track", origin: "limey",
        stability: "production", cadence: "per release", audience: "everyone",
        description: "Default, reviewed track. Builds are hash-stamped and served by the installer; changes get a changelog entry.",
        implemented: true
    },
    {
        id: "dev", name: "Development (DevBuild)", category: "track", origin: "limey",
        stability: "unstable", cadence: "per commit (git updater)", audience: "developers and contributors",
        description: "Source-built flavor. Self-identifies as a DevBuild (support warning, git updater active).",
        implemented: true
    },
    {
        id: "devbuild", name: "DevBuild", category: "track", origin: "limey",
        stability: "unstable", cadence: "= dev", audience: "alias of dev",
        description: "Runtime label of a dev build; kept so existing DevBuild checks keep working.",
        implemented: false, aliases: ["dev"]
    },
    {
        id: "rc", name: "Release Candidate", category: "track", origin: "proposed",
        stability: "testing", cadence: "one per release cycle", audience: "testers pre-validating",
        description: "Feature-complete pre-release of the next stable version; folded into stable once clean. Published to dist/rc/ per release cycle; between cycles the channel reports not-published.",
        implemented: true
    },
    {
        id: "beta", name: "Beta", category: "track", origin: "proposed",
        stability: "testing", cadence: "per feature batch", audience: "curious early adopters",
        description: "Public pre-release accumulating features for the next version. Published to dist/beta/ per feature batch; between batches the channel reports not-published.",
        implemented: true
    },
    {
        id: "preview", name: "Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "with each dev batch", audience: "non-technical early adopters",
        description: "Friendly umbrella label for the pre-release family (rc/beta); UI alias, not an installable channel.",
        implemented: false, aliases: ["beta", "rc"]
    },
    {
        id: "alpha", name: "Alpha", category: "track", origin: "proposed",
        stability: "unstable", cadence: "per feature batch, before beta", audience: "plugin developers porting early",
        description: "Earliest shipped pre-release: code that will change shape, frozen per fresh feature batch; unpublished batches answer not-published.",
        implemented: true
    },
    {
        id: "canary", name: "Canary (Limey)", category: "track", origin: "limey",
        stability: "unstable", cadence: "per batch, freshest shipped pre-release", audience: "adventurous testers",
        description: "Freshest shipped pre-release of the next version, refrozen per batch ahead of beta. Not to be confused with the discord-canary host (Discord's client branch). Install with --channel canary.",
        implemented: true
    },
    {
        id: "nightly", name: "Nightly", category: "track", origin: "proposed",
        stability: "unstable", cadence: "daily cron of main", audience: "automated cross-testing",
        description: "Scheduled snapshot of the main branch, built automatically even if commits are broken.",
        implemented: true
    },
    {
        id: "edge", name: "Edge", category: "track", origin: "proposed",
        stability: "volatile", cadence: "per push", audience: "CI systems",
        description: "Purest freshness: built per successful push, no schedule. Expect arbitrary machine state.",
        implemented: true
    },
    {
        id: "debug", name: "Debug", category: "track", origin: "proposed",
        stability: "internal", cadence: "on demand", audience: "core developers",
        description: "Verbose-logging diagnostic build; not meant to leave the build machine.",
        implemented: true
    },
    {
        id: "custom", name: "Custom Build", category: "track", origin: "proposed",
        stability: "volatile", cadence: "owner-driven", audience: "fork maintainers",
        description: "A user-built flavor from a fork with extra patches, distinct branding or plugin changes — owner-driven.",
        implemented: true
    },
    {
        id: "snapshot", name: "Snapshot", category: "track", origin: "proposed",
        stability: "unstable", cadence: "manual or test-gated", audience: "plugin CI",
        description: "Point-in-time named dev build; inclusion is manual or gated on tests, unlike nightly's cron.",
        implemented: true
    },
    {
        id: "experimental", name: "Experimental", category: "track", origin: "proposed",
        stability: "volatile", cadence: "with the experiments", audience: "plugin authors opting into flags",
        description: "Aggregates opt-in functionality (feature-flagged plugins, rewrites) pinned to a stable-ish base.",
        implemented: true
    },
    {
        id: "early", name: "Early Access", category: "track", origin: "proposed",
        stability: "testing", cadence: "same as beta/rc", audience: "perk-tier subscribers",
        description: "Logged-in users get the next feature batch a little earlier, built from rc-quality code.",
        implemented: true
    },
    {
        id: "insider", name: "Insider", category: "track", origin: "proposed",
        stability: "testing", cadence: "batch-shaped", audience: "users who want the why",
        description: "Same artifacts as beta, packaged with per-batch release notes ('read the dev diary' crowd).",
        implemented: true
    },
    {
        id: "preview-ch", name: "Preview Channel", category: "track", origin: "proposed",
        stability: "testing", cadence: "same as beta", audience: "same as beta",
        description: "Friendlier folded display name for the beta stream, so settings can say 'Preview (Beta)'.",
        implemented: true
    },
    {
        id: "dev-preview", name: "Developer Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "per planned release milestone", audience: "plugin ecosystem maintainers",
        description: "Spec-stable subset of the upcoming release — API/schema/patch points the plugin ecosystem depends on.",
        implemented: true
    },
    {
        id: "internal", name: "Internal Testing", category: "track", origin: "proposed",
        stability: "internal", cadence: "irregular", audience: "core collaborators",
        description: "Small ring for core collaborators before anything public: checksums, unreleased heuristics, security fixes.",
        implemented: true
    },
    {
        id: "community", name: "Community Preview", category: "track", origin: "proposed",
        stability: "testing", cadence: "community-driven", audience: "plugin community, store authors",
        description: "Public 'vote on what's next' lobe — top-voted candidate experiments advance to beta.",
        implemented: true
    },

    // ---------------- Hosts ----------------
    {
        id: "discord-stable", name: "Discord Stable", category: "host", origin: "discord",
        stability: "production", cadence: "Discord-driven", audience: "everyone",
        description: "Mainstream Discord desktop app. Default install target of the installer.",
        implemented: true
    },
    {
        id: "discord-ptb", name: "Discord PTB", category: "host", origin: "discord",
        stability: "testing", cadence: "Discord-driven, before wide release", audience: "opt-in testers",
        description: "Discord's wide pre-stable client branch. Detected and supported by the installer.",
        implemented: true
    },
    {
        id: "discord-canary", name: "Discord Canary", category: "host", origin: "discord",
        stability: "unstable", cadence: "near daily, from Discord", audience: "client-mod developers",
        description: "Discord's fastest-moving client branch; catches patch-target drift early.",
        implemented: true
    },
    {
        id: "discord-development", name: "Discord Development", category: "host", origin: "discord",
        stability: "volatile", cadence: "erratic, from Discord", audience: "Discord staff and client mod devs",
        description: "Discord's internal-flavor branch, occasionally distributed.",
        implemented: true
    },
    {
        id: "web", name: "Web Client (browser)", category: "host", origin: "limey",
        stability: "production", cadence: "per stable release", audience: "browser-first users",
        description: "Chrome MV3 extension, Firefox shell and userscripts for discord.com.",
        implemented: true
    },
    {
        id: "custom-client", name: "Custom Client Build", category: "host", origin: "proposed",
        stability: "volatile", cadence: "owner-driven", audience: "fork operators",
        description: "Third-party Discord-compatible clients; best-effort, unsupported.",
        implemented: false
    },

    // ---------------- Rollout strategies ----------------
    {
        id: "full", name: "Immediate (Full rollout)", category: "rollout", origin: "limey",
        stability: "production", cadence: "per release", audience: "everyone",
        description: "Newest served to everyone as soon as the hash flips. Current behavior.",
        implemented: true
    },
    {
        id: "canary-rollout", name: "Canary Rollout", category: "rollout", origin: "proposed",
        stability: "production", cadence: "per release, percentage-driven", audience: "volunteers",
        description: "Ship first to a tiny percentage of volunteers before the broader audience. Distinct from the canary track (a shipped pre-release build) and from the Discord canary host branch.",
        implemented: false
    },
    {
        id: "progressive", name: "Progressive Rollout", category: "rollout", origin: "proposed",
        stability: "production", cadence: "cohort gates", audience: "everyone, spread over time",
        description: "1% → 10% → 50% → 100% cohorts, each gated on error telemetry.",
        implemented: false
    },
    {
        id: "featureflagged", name: "Feature-Flagged Release", category: "rollout", origin: "proposed",
        stability: "production", cadence: "continuous, no reinstall", audience: "everyone",
        description: "Ship disabled features to stable, enable them remotely per user/cohort.",
        implemented: false
    },
    {
        id: "rollback", name: "Rollback", category: "rollout", origin: "proposed",
        stability: "production", cadence: "emergency only", audience: "users being protected",
        description: "Re-point users to the last known good hash after a bad release.",
        implemented: false
    },

    // ---------------- Maintenance states ----------------
    {
        id: "hotfix", name: "Hotfix", category: "maintenance", origin: "proposed",
        stability: "production", cadence: "as needed", audience: "everyone (fast-tracked)",
        description: "Out-of-band patch bypassing normal gates because the live product is broken.",
        implemented: false
    },
    {
        id: "security-patch", name: "Security Patch", category: "maintenance", origin: "proposed",
        stability: "production", cadence: "as vulnerabilities are found", audience: "everyone",
        description: "Hotfix with silent deploy priority; reaches stable before a changelog is cut.",
        implemented: false
    },
    {
        id: "legacy", name: "Legacy", category: "maintenance", origin: "proposed",
        stability: "testing", cadence: "rare", audience: "users on old Discord versions",
        description: "Old client-version-limited builds kept around with explicit support dates.",
        implemented: false
    },
    {
        id: "deprecated", name: "Deprecated", category: "maintenance", origin: "vencord",
        stability: "testing", cadence: "until removal", audience: "everyone",
        description: "Scheduled for removal; updater nags with a transition link.",
        implemented: false
    },
    {
        id: "lts", name: "Stable LTS", category: "maintenance", origin: "limey",
        stability: "production", cadence: "security/crash fixes only", audience: "downtime-sensitive setups",
        description: "Frozen stable snapshot with a long support window. Served from the backend's dist/lts/ snapshot; tracks stable until the first pin is published. Install with the installer's --channel lts.",
        implemented: true
    },
    {
        id: "archived", name: "Archived", category: "maintenance", origin: "proposed",
        stability: "testing", cadence: "never updates", audience: "historians, forensics",
        description: "Read-only snapshots; inspectable, not installable.",
        implemented: false
    }
];

export type TrackId = "stable" | "dev";

export interface ReleaseTrack {
    id: TrackId;
    name: string;
    description: string;
    channel: ReleaseChannel;
}

/**
 * Which track this running build came from.
 *
 * Mirrors the build scripts' `--standalone` flag: official, installer/updater
 * -served builds are standalone → `stable`; anything built locally for
 * development/inspection is a `dev` DevBuild (and self-identifies as one).
 * The web bundle follows the same rule.
 */
export function getReleaseTrack(): ReleaseTrack {

    const trackId: TrackId = IS_STANDALONE ? "stable" : "dev";
    const channel = RELEASE_CHANNELS.find(ch => ch.id === trackId)!;
    return trackId === "stable"
        ? {
            id: "stable",
            name: "Stable",
            description: "Official Limey V1 build, hash-stamped and served by the update backend.",
            channel
        }
        : {
            id: "dev",
            name: "Development (DevBuild)",
            description: "Source build — the git updater is active and support requests may be declined.",
            channel
        };
}

/** Look up a channel by id or accepted alias; `devbuild` finds the dev channel. */
export function getReleaseChannel(id: string): ReleaseChannel | undefined {
    const exact = RELEASE_CHANNELS.find(ch => ch.id === id);
    if (exact) return exact.implemented ? exact : undefined;
    const aliased = RELEASE_CHANNELS.find(ch => Boolean(ch.implemented) && ch.aliases?.includes(id));
    return aliased;
}

export const RELEASE_CHANNELS_DOC_URL = "https://limey-discord.onrender.com/docs/release-channels";

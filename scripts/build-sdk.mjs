/*
 * Build script for @limeyV1/sdk.
 *
 * The SDK source is a single hand-written ES module (src/index.js) that is
 * consumed directly inside this repo — no bundler needed. We publish it to
 * `dist/` unchanged (the "bundler" step) alongside a TypeScript declaration
 * file (`.d.ts`) so typed bot projects get completions:
 *
 *   dist/index.js   — the actual module (plain ESM, Node >= 18)
 *   dist/index.d.ts — the hand-maintained type surface
 */
import { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..", "packages", "limey-v1-sdk");
const src = path.join(pkgDir, "src", "index.js");
const dist = path.join(pkgDir, "dist");if (!existsSync(src)) {
    console.error("[sdk] missing source at", src);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// dist/index.d.ts content (built below in writeDist())
// ---------------------------------------------------------------------------
const DECL = /* dts */ `
export declare const DEFAULT_BASE_URL: string;
export declare const LIMES_RATES: Readonly<{
    daily: Readonly<{ amount: number; cooldownMs: number }>;
    message: Readonly<{ amount: number; perMessages: number; capPerDay: number }>;
    voiceMinute: Readonly<{ amount: number; perMinutes: number; capPerDay: number }>;
    streaming: Readonly<{ amount: number; perMinutes: number; capPerDay: number }>;
    game: Readonly<{ amount: number; perMinutes: number; capPerDay: number }>;
    streakBonus: number;
    streakCap: number;
}>;

export declare class LimeyV1Error extends Error {
    status: number;
    code: string;
    data: unknown;
    constructor(message: string, meta?: { status?: number; code?: string; data?: unknown; cause?: unknown });
}

export interface LimeyV1Options {
    baseUrl?: string;
    adminToken?: string;
    timeoutMs?: number;
    retries?: number;
    userAgent?: string;
    logger?: { info?(...args: unknown[]); warn?(...args: unknown[]); error?(...args: unknown[]) };
    dryRun?: boolean;
}

export interface LimeyStatus {
    active: boolean;
    message: string;
    startedAt: string | null;
    updatedAt: string | null;
}

export interface BanCheckResult {
    banned: boolean;
    reason?: string;
    bannedAt?: string | null;
}

export interface LimesWallet {
    user: unknown | null;
    balance: number;
    streak: number;
    tier: string | null;
    multiplier: number;
    nextDailyAt: number;
}

export interface LimesTier {
    id: string;
    name: string;
    pricePerMonth: number;
    trialDays: number;
    perks: string[];
    perksStart: number;
}

export interface CommunityPlugin {
    name: string;
    description: string;
    [extra: string]: unknown;
}

export interface LimeyChannel {
    id: string;
    name: string;
    category: "track" | "host" | "rollout" | "maintenance";
    origin: "limey" | "vencord" | "discord" | "discord-process" | "proposed";
    stability: string;
    cadence: string;
    audience: string;
    description: string;
    implemented: boolean;
    aliases?: string[];
    artifacts?: string[];
}

export interface LimeyChannelsManifest {
    schema: string;
    strategy: string;
    implementedOnly: Record<string, string[]>;
    channels: LimeyChannel[];
}

export declare class HttpClient {
    constructor(options?: LimeyV1Options);
    request(path: string, options?: {
        method?: "GET" | "POST" | "PUT" | "DELETE";
        body?: unknown;
        headers?: Record<string, string>;
        retries?: number;
    }): Promise<unknown>;
    static qs(params: Record<string, unknown> | undefined): string;
}

export declare class LimeyV1 {
    http: HttpClient;
    readonly status: { get(): Promise<LimeyStatus>; isActive(): Promise<boolean> };
    readonly bans: { check(userId: string): Promise<BanCheckResult>; isBanned(userId: string): Promise<boolean> };
    readonly detector: { users(): Promise<{ users: string[]; countries: unknown }> };
    readonly limes: {
        wallet(userId: string): Promise<LimesWallet>;
        history(userId: string): Promise<{ history: unknown[] }>;
        tiers(): Promise<{ currency: string; tiers: LimesTier[] }>;
        perks(userId: string): Promise<{ tier: string | null; expiresAt: number | null; trialsUsed: Record<string, boolean> }>;
        claimDaily(userId: string): Promise<{ amount: number; balance: number; streak: number }>;
        countMessages(userId: string, count: number): Promise<{ awarded: number; balance: number }>;
        countVoice(userId: string, minutes: number): Promise<{ awarded: number; balance: number }>;
        countStreaming(userId: string, minutes: number): Promise<{ awarded: number; balance: number }>;
        countGame(userId: string, minutes: number): Promise<{ awarded: number; balance: number }>;
        startTrial(userId: string, tier: string): Promise<unknown>;
        subscribe(userId: string, tier: string): Promise<unknown>;
        redeemDonationCode(token: string, code: string): Promise<unknown>;
    };
    readonly plugins: { list(): Promise<CommunityPlugin[]>; get(name: string): Promise<CommunityPlugin> };
    readonly tools: { lookupInvite(code: string): Promise<unknown>; lookupGuild(guildId: string): Promise<unknown> };
    readonly channels: {
        manifest(): Promise<LimeyChannelsManifest>;
        list(): Promise<LimeyChannel[]>;
        get(id: string): Promise<LimeyChannel>;
    };
    readonly sentinel: {
        challenge(query?: Record<string, unknown>): Promise<Record<string, unknown>>;
        solveToken(maxIterations?: number): Promise<string>;
    };
    readonly state: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
    readonly botState: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };

    constructor(options?: LimeyV1Options);
    ping(): Promise<LimeyStatus>;
}
export declare const Base64Url: { encode(input: string | unknown): string };
export default LimeyV1;
`;

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(src, path.join(dist, "index.js"));

// Hand-write the public declaration file — keeps the type surface small,
// readable and stable in lock-step with src/index.js.
writeFileSync(path.join(dist, "index.d.ts"), DECL);

// Publish the built module to the website so any bot developer can import it
// straight from limey-discord.onrender.com without installing anything:
//   import { LimeyV1 } from "https://limey-discord.onrender.com/sdk/index.js";
// (Node ESM supports https imports natively; the CDN copy is pure JS.)
const webDir = path.join(here, "..", "public", "sdk");
mkdirSync(webDir, { recursive: true });
cpSync(path.join(dist, "index.js"), path.join(webDir, "index.js"));
cpSync(path.join(dist, "index.d.ts"), path.join(webDir, "index.d.ts"));

console.log("[sdk] built @limeyV1/sdk ->", path.relative(process.cwd(), dist));

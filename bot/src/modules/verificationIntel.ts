/*
 * Verification intel: asks an IP reputation service whether a verifying member
 * is on a VPN/proxy/Tor/datacenter address, and remembers a keyed hash of the
 * address so two accounts behind the same connection can be pointed out to
 * staff.
 *
 * This handles other people's data, so the limits are deliberate:
 *   - the raw IP is never written to disk, only HMAC-SHA256(secret, ip)
 *   - nothing is recorded at all until LIMEY_VERIFY_SECRET is set, so a
 *     deployment can never end up storing weakly-hashed addresses
 *   - records expire after Config.verification.intel.retentionDays
 *   - a shared address is an alert for staff, never an automatic punishment:
 *     households, schools, carrier NAT and VPNs all produce them
 *   - the verify page and the bot's DM both say what is recorded and why
 */

import { createHash, createHmac } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { Vaius } from "~/Client";
import Config from "~/config";
import { DATA_DIR } from "~/constants";
import { atomicWriteFileSync } from "~/util/atomicWriteFile";

const StateFile = join(DATA_DIR, "verificationIntel.json");
const MAX_RECORDS = 20000;
const VERDICT_TTL = 6 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 4000;

export interface VerifyMeta {
    ip?: string | null;
    userAgent?: string | null;
}

interface IntelRecord {
    guildId: string;
    userId: string;
    ipHash: string;
    uaHash: string | null;
    country: string | null;
    vpn: boolean;
    vpnKind: string | null;
    createdAt: string;
}

interface IpVerdict {
    vpn: boolean;
    kind: string | null;
    country: string | null;
}

export interface VerificationAssessment {
    allowed: boolean;
    reason: "vpn" | null;
    message: string | null;
    confidence: number;
    signals: string[];
    alts: string[];
}

/** Thrown instead of granting the role when the check blocks verification. */
export class VerificationBlockedError extends Error {
    readonly verificationBlocked = true;

    constructor(readonly reason: string, message: string) {
        super(message);
        this.name = "VerificationBlockedError";
    }
}

let records: IntelRecord[] = loadRecords();
let warnedNoSecret = false;
const verdicts = new Map<string, { at: number; verdict: IpVerdict }>();

/** What the verify page and the bot's DM tell the member. */
export function verifyDisclosure() {
    const site = Config.verification.siteUrl;
    return `Verification records a keyed hash of your IP address (never the address itself) and a VPN check, so alt accounts can be spotted — details: ${site}/privacy`;
}

function loadRecords(): IntelRecord[] {
    try {
        if (!existsSync(StateFile)) return [];
        const parsed = JSON.parse(readFileSync(StateFile, "utf8"));
        const list = Array.isArray(parsed?.records) ? parsed.records : [];
        return list.filter((r: any) =>
            r
            && typeof r.guildId === "string"
            && typeof r.userId === "string"
            && typeof r.ipHash === "string"
            && typeof r.createdAt === "string");
    } catch (e) {
        console.error("[verify-intel] could not read stored records:", e);
        return [];
    }
}

function retentionDays() {
    const configured = Number(Config.verification.intel.retentionDays);
    return Number.isFinite(configured) && configured > 0 ? configured : 90;
}

function prune() {
    const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
    records = records.filter(r => {
        const at = Date.parse(r.createdAt);
        return Number.isFinite(at) && at >= cutoff;
    });
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
}

function save() {
    prune();
    try {
        atomicWriteFileSync(StateFile, JSON.stringify({ schema: 1, records }, null, 2));
    } catch (e) {
        console.error("[verify-intel] failed to persist records:", e);
    }
}

/** Drop the port, the IPv4-in-IPv6 prefix, and anything that is not a
 *  publicly routable address worth looking up. */
export function normalizeIp(raw: string | null | undefined) {
    if (typeof raw !== "string") return null;
    let ip = raw.trim();
    if (!ip) return null;

    if (ip.startsWith("[")) {
        const end = ip.indexOf("]");
        if (end > 0) ip = ip.slice(1, end);
    }
    // "1.2.3.4:5678" — strip the port, but keep bare IPv6 intact
    if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
    if (ip.startsWith("::ffff:")) ip = ip.slice(7);

    if (ip === "::1" || ip === "unknown") return null;
    if (/^127\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return null;
    if (/^169\.254\./.test(ip) || /^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)) return null;

    return ip;
}

function hashIp(ip: string) {
    const key = process.env.LIMEY_VERIFY_SECRET || "";
    if (!key) {
        if (!warnedNoSecret) {
            warnedNoSecret = true;
            console.warn("[verify-intel] LIMEY_VERIFY_SECRET is not set — IP checks are off so no weakly-hashed addresses are stored");
        }
        return null;
    }
    return createHmac("sha256", key).update(ip).digest("hex");
}

function hashUserAgent(userAgent: string | null | undefined) {
    if (typeof userAgent !== "string" || !userAgent) return null;
    return createHash("sha256").update(userAgent).digest("hex").slice(0, 32);
}

/** VPN / proxy / Tor / hosting lookup, cached for six hours per address. */
export async function lookupIp(ip: string): Promise<IpVerdict | null> {
    const cached = verdicts.get(ip);
    if (cached && Date.now() - cached.at < VERDICT_TTL) return cached.verdict;

    const cfg = Config.verification.intel;
    const key = process.env[cfg.apiKeyEnv] || "";
    const url = `${cfg.apiUrl}/${encodeURIComponent(ip)}?vpn=1&asn=1${key ? `&key=${encodeURIComponent(key)}` : ""}`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "limebot-verification-intel" },
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as Record<string, any>;
        // proxycheck answers { status: "ok", "<ip>": { proxy, type, isocode } }
        // and puts the reason in `message` once the free quota is spent.
        if (String(data.status) !== "ok") throw new Error(String(data.message ?? data.status ?? "lookup failed"));

        const node = (data[ip] ?? Object.values(data).find(v => v && typeof v === "object")) as any;
        const verdict: IpVerdict = {
            vpn: String(node?.proxy ?? "no").toLowerCase() === "yes",
            kind: typeof node?.type === "string" ? node.type : null,
            country: typeof node?.isocode === "string" ? node.isocode : null,
        };

        verdicts.set(ip, { at: Date.now(), verdict });
        if (verdicts.size > 5000) verdicts.clear();
        return verdict;
    } catch (e: any) {
        // Unknown is not the same as clean: leave the member alone and say so.
        console.warn("[verify-intel] IP lookup failed:", e?.message ?? e);
        return null;
    }
}

/**
 * Two accounts on one address is a lead, not proof, so the score tops out
 * below "certain" and every extra signal is listed separately.
 */
function confidenceFor(altCount: number, sameDevice: boolean) {
    if (!altCount) return 0;
    let score = 40 + Math.min(30, (altCount - 1) * 15);
    if (sameDevice) score += 20;
    return Math.min(95, score);
}

function confidenceLabel(score: number) {
    if (score >= 70) return "high";
    if (score >= 50) return "medium";
    return "low";
}

async function alertStaff(guildId: string, userId: string, info: {
    confidence: number;
    signals: string[];
    alts: string[];
    vpn: boolean;
    country: string | null;
}) {
    const channelId = Config.verification.intel.logChannelId;
    if (!channelId) return;

    const lines = [
        "🕵️ **Verification intel**",
        `User: \`${userId}\` in guild \`${guildId}\``,
        info.alts.length ? `Accounts already seen on the same address: ${info.alts.map(id => `\`${id}\``).join(", ")}` : null,
        `Confidence: **${confidenceLabel(info.confidence)} (${info.confidence})** — ${info.signals.join("; ") || "no signals"}`,
        info.country ? `Country: ${info.country}` : null,
        "",
        "-# A shared address can be a household, a school, carrier NAT or a VPN. Treat this as a lead, not a verdict.",
    ].filter(Boolean);

    try {
        await Vaius.rest.channels.createMessage(channelId, {
            content: lines.join("\n"),
            // ids are in code spans and nothing here should ping anyone
            allowedMentions: { everyone: false, roles: [], users: [] },
        });
    } catch (e) {
        console.error("[verify-intel] failed to post the alert:", e);
    }
}

/**
 * Runs before the verified role is granted. Returns the assessment; throws
 * VerificationBlockedError when the config says to refuse VPN addresses.
 */
export async function assessVerification(guildId: string, userId: string, meta?: VerifyMeta): Promise<VerificationAssessment> {
    const cfg = Config.verification.intel;
    const clear: VerificationAssessment = { allowed: true, reason: null, message: null, confidence: 0, signals: [], alts: [] };
    if (!cfg.enabled) return clear;

    const ip = normalizeIp(meta?.ip);
    if (!ip) return clear;
    const ipHash = hashIp(ip);
    if (!ipHash) return clear;

    const uaHash = hashUserAgent(meta?.userAgent);
    const verdict = await lookupIp(ip);
    const vpn = !!verdict?.vpn;

    prune();
    const onSameAddress = records.filter(r => r.guildId === guildId && r.ipHash === ipHash && r.userId !== userId);
    const alts = [...new Set(onSameAddress.map(r => r.userId))];
    const sameDevice = !!uaHash && onSameAddress.some(r => r.uaHash === uaHash);
    const isNew = !records.some(r => r.guildId === guildId && r.userId === userId && r.ipHash === ipHash);

    if (isNew) {
        records.push({
            guildId,
            userId,
            ipHash,
            uaHash,
            country: verdict?.country ?? null,
            vpn,
            vpnKind: verdict?.kind ?? null,
            createdAt: new Date().toISOString(),
        });
        save();
    }

    const confidence = confidenceFor(alts.length, sameDevice);
    const signals: string[] = [];
    if (alts.length) signals.push(`shared address with ${alts.length} other account${alts.length === 1 ? "" : "s"}`);
    if (sameDevice) signals.push("same browser fingerprint");
    if (vpn) signals.push(`VPN/proxy detected (${verdict?.kind ?? "unknown type"})`);

    if (vpn && cfg.vpnBlock) {
        return {
            allowed: false,
            reason: "vpn",
            message: "Verification is blocked from VPN, proxy, Tor and datacenter addresses. Turn it off and try again — ask a moderator if you think this is wrong.",
            confidence,
            signals,
            alts,
        };
    }

    if (cfg.altAlerts && isNew && (alts.length || vpn)) {
        await alertStaff(guildId, userId, { confidence, signals, alts, vpn, country: verdict?.country ?? null });
    }

    return { allowed: true, reason: null, message: null, confidence, signals, alts };
}

/** Drop a member's records (used when they ask for their data to be erased). */
export function forgetVerificationData(userId: string) {
    const before = records.length;
    records = records.filter(r => r.userId !== userId);
    if (records.length !== before) save();
    return before - records.length;
}

/** Test/dev helper: how many records are on disk for a guild. */
export function intelStats(guildId: string) {
    prune();
    const inGuild = records.filter(r => r.guildId === guildId);
    return {
        records: inGuild.length,
        addresses: new Set(inGuild.map(r => r.ipHash)).size,
        users: new Set(inGuild.map(r => r.userId)).size,
    };
}

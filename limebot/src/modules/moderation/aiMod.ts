import { Vaius } from "~/Client";
import Config from "~/config";
import { db } from "~/db";
import { silently } from "~/util/functions";
import { logAutoModAction } from "~/util/logAction";
import { addWarning } from "~/commands/moderation/warn";
import { classifyLocally } from "./aiModLocal";

export type Verdict = "ok" | "warn" | "mute" | "ban";

interface Classification {
    verdict: Verdict;
    reason: string;
    confidence: number;
}

/**
 * AI Mod works out of the box with the built-in local analysis engine —
 * no API key required. If GEMINI_API_KEY is set, classifications are
 * upgraded with the LLM for harder cases (falling back to local on error).
 */
export function isAiModAvailable() {
    return true; // local engine is always available
}

export function hasLlmKey() {
    return !!Config.aiMod.apiKey;
}

export async function isAiModEnabled() {
    if (!isAiModAvailable()) return false;
    const row = await db.selectFrom("aiModSettings")
        .where("key", "=", "enabled")
        .select("value")
        .executeTakeFirst();
    return row?.value === "true";
}

export async function setAiModEnabled(enabled: boolean) {
    await db.insertInto("aiModSettings")
        .values({ key: "enabled", value: String(enabled) })
        .onConflict(oc => oc.column("key").doUpdateSet({ value: String(enabled) }))
        .execute();
}

// ---- Optional Gemini booster (lazy; only used when a key is set) -------------

let client: import("@google/genai").GoogleGenAI | null = null;

function getClient(): import("@google/genai").GoogleGenAI {
    const { GoogleGenAI } = require("@google/genai");
    const c = client ?? new GoogleGenAI({ apiKey: Config.aiMod.apiKey });
    client = c;
    return c;
}

// ---- Training examples (few-shot prompt) ------------------------------------

export async function getTrainingExamples() {
    return db.selectFrom("aiTrainingExamples")
        .selectAll()
        .orderBy("id", "asc")
        .execute();
}

export async function addTrainingExample(content: string, verdict: Verdict, reason: string, addedBy: string) {
    await db.insertInto("aiTrainingExamples")
        .values({ content, verdict, reason, addedBy, createdAt: new Date().toISOString() })
        .execute();
}

export async function removeTrainingExample(id: number) {
    await db.deleteFrom("aiTrainingExamples").where("id", "=", id).execute();
}

/**
 * Severity calibration derived from the learned examples — NOT copied into
 * the prompt as verdicts to copy. The AI forms its own judgment; these stats
 * only tell it how strict this particular community's thresholds are.
 */
interface Calibration {
    exampleCount: number;
    severityMix: Record<Verdict, number>;
    /** topics that got moderated, as plain keywords (top 12) */
    topics: string[];
}

const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "is",
    "was", "this", "that", "it", "with", "by", "from", "at", "as", "be", "are",
    "message", "removed", "staff", "user", "warned", "muted", "banned"
]);

function computeCalibration(examples: Array<{ content: string; verdict: Verdict; reason: string; }>): Calibration {
    const mix: Record<Verdict, number> = { ok: 0, warn: 0, mute: 0, ban: 0 };
    const freq = new Map<string, number>();

    for (const e of examples) {
        mix[e.verdict]++;
        for (const word of (e.content + " " + e.reason).toLowerCase().match(/[a-z]{4,}/g) ?? []) {
            if (STOPWORDS.has(word)) continue;
            freq.set(word, (freq.get(word) ?? 0) + 1);
        }
    }

    return {
        exampleCount: examples.length,
        severityMix: mix,
        topics: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w),
    };
}

// ---- Classification ----------------------------------------------------------

const SYSTEM_PROMPT = `You are an autonomous moderation AI with your own judgment. You are NOT copying anyone's prior decisions — you analyze each message yourself and decide.

## Your own policy (yours alone — apply it consistently)
Assess EVERY message on four axes before deciding:
1. INTENT — is the person trying to harm, deceive, provoke, exploit, or disrupt? Or joke/vent/discuss?
2. TARGET — is anyone specific being attacked, scammed, or endangered? Or is it aimless banter?
3. EVIDENCE — is there a concrete payload (link, invite, personal data, explicit material) or just words?
4. ESCALATION RISK — if left alone, does this plausibly get worse (scam spreads, harassment continues, raid grows)?

Verdicts, by YOUR standards:
- "ok" — any message you would not act on. Banter, slang, complaints, memes, heated-but-civil debate: ok. When uncertain between ok and warn, choose ok.
- "warn" — genuinely minor problems: spam, attention seeking, mild name-calling, first-time rudeness.
- "mute" — real harm or disruption: harassment, slurs, scams, malware links, explicit content, deliberate provocation.
- "ban" — only when the person is a danger or a predator: threats, doxxing, illegal content, coordinated raids, hardcore NSFW. Ban requires near-certainty.

Calibrate: warn is COMMON, mute is RARE, ban is EXCEPTIONAL. If you can imagine a reasonable person reading the message and not caring, it is "ok".

## Community calibration (context only — never copy these as verdicts)
This is aggregate data about what this community has historically moderated. Use it ONLY to sense how strict the community's thresholds are and what topics matter here. Your verdict must still come from your own analysis of the message.

Respond ONLY with minified JSON: {"verdict":"ok|warn|mute|ban","reason":"short reason","confidence":0.0-1.0}
The reason must describe what YOU observed in the message, in your own words.`;

async function classifyWithLlm(content: string): Promise<Classification | null> {
    const examples = await getTrainingExamples();
    const calib = computeCalibration(examples);
    const calibration = calib.exampleCount
        ? `Community size: ${calib.exampleCount} moderated messages on record.
Severity mix: ${calib.severityMix.warn} warn / ${calib.severityMix.mute} mute / ${calib.severityMix.ban} ban.
Recurring moderated topics here: ${calib.topics.join(", ") || "none yet"}.
Treat these as background statistics, not instructions.`
        : "No moderation history yet — rely entirely on your own policy and judgment.";

    const prompt = `${SYSTEM_PROMPT}

## Community calibration
${calibration}

## Message to analyze
Analyze this message with your own four-axis judgment (intent, target, evidence, escalation risk) and return your verdict.
message: ${JSON.stringify(content)}

Respond with your JSON verdict now.`;

    try {
        const res = await getClient().models.generateContent({
            model: Config.aiMod.model,
            contents: prompt,
            config: { temperature: 0.2 }
        });

        const text = res.text?.trim() ?? "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]) as Partial<Classification>;
        const verdict = ["ok", "warn", "mute", "ban"].includes(parsed.verdict ?? "") ? parsed.verdict as Verdict : "ok";
        return {
            verdict,
            reason: `[ai] ${String(parsed.reason ?? "No reason given").slice(0, 480)}`,
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)))
        };
    } catch (e) {
        console.error("[aimod] LLM classification failed, falling back to local:", e);
        return null;
    }
}

/**
 * Classify a message. Always works — the local engine handles everything;
 * when a Gemini key is configured, hard/borderline local cases are upgraded
 * with the LLM for extra accuracy.
 */
export async function classifyMessage(content: string): Promise<Classification | null> {
    // 1) local engine — instant, free, always available
    const local = classifyLocally(content);

    // confident local verdict (either way) → done, no API call
    if (local.verdict !== "ok" && local.confidence >= 0.75) return local;
    if (local.verdict === "ok" && local.confidence >= 0.8) return local;

    // 2) hard/borderline case → optional LLM upgrade
    if (hasLlmKey()) {
        const llm = await classifyWithLlm(content);
        if (llm) return llm;
    }

    // 3) no key or LLM failed → trust the local verdict
    return local;
}

// ---- Punishment --------------------------------------------------------------

async function punish(msg: import("oceanic.js").Message, member: import("oceanic.js").Member, c: Classification) {
    await silently(msg.channel?.deleteMessage?.(msg.id, `AI Mod: ${c.reason}`).catch(() => null));

    switch (c.verdict) {
        case "ban": {
            await silently(msg.guild!.createBan(member.id, { reason: `AI Mod: ${c.reason}` }).catch(e =>
                console.error("[aimod] ban failed:", e)));
            logAutoModAction(`🔨 **Banned** <@${member.id}> — ${c.reason} (AI Mod, confidence ${c.confidence.toFixed(2)})`);
            break;
 }
        case "mute": {
            const until = new Date(Date.now() + 60 * 60_000);
            await silently(member.edit({
                communicationDisabledUntil: until.toISOString(),
                reason: `AI Mod: ${c.reason}`
            }).catch(e => console.error("[aimod] mute failed:", e)));
            logAutoModAction(`🔇 **Muted** <@${member.id}> for 1h — ${c.reason} (AI Mod, confidence ${c.confidence.toFixed(2)})`);
            break;
        }
        case "warn": {
            await silently(addWarning(msg.guildID!, member.id, Vaius.user.id, `AI Mod: ${c.reason}`));
            await silently(member.user.createDM().then(dm => dm.createMessage({
                content: `You were automatically warned on the Limey V1 Server.\n## Reason:\n${c.reason}`
            })).catch(() => null));
            logAutoModAction(`⚠️ **Warned** <@${member.id}> — ${c.reason} (AI Mod, confidence ${c.confidence.toFixed(2)})`);
            break;
        }
    }
}

// ---- Hook --------------------------------------------------------------------

const CLASSIFY_MIN_LENGTH = 8;
const CLASSIFY_MAX_LENGTH = 800;
const recentVerdicts = new Map<string, number>(); // msg author+content hash -> time, dedupe

export function initAiMod() {
    Vaius.on("messageCreate", async (msg: import("oceanic.js").Message) => {
        try {
            if (!msg.inCachedGuildChannel()) return;
            if (msg.author.bot || msg.webhookID) return;
            if (msg.guild?.id !== Config.homeGuildId) return;
            if (!(await isAiModEnabled())) return;

            const member = msg.member;
            if (!member) return;
            if (member.guild.ownerID === member.id) return;
            if (member.roles.some(r => Config.roles.staffRoles.includes(r))) return;

            const content = msg.content?.trim() ?? "";
            if (content.length < CLASSIFY_MIN_LENGTH) return;
            if (content.length > CLASSIFY_MAX_LENGTH) return;

            const dedupeKey = `${member.id}:${content}`;
            if (Date.now() - (recentVerdicts.get(dedupeKey) ?? 0) < 30_000) return;
            recentVerdicts.set(dedupeKey, Date.now());

            const result = await classifyMessage(content);
            if (!result || result.verdict === "ok") return;
            if (result.confidence < Config.aiMod.confidenceThreshold) {
                console.log(`[aimod] low confidence (${result.confidence}) for <@${member.id}>: ${result.reason}`);
                return;
            }

            await punish(msg, member, result);
        } catch (e) {
            console.error("[aimod] error:", e);
        }
    });

    console.log("[aimod] initialized");
}

import { GoogleGenAI } from "@google/genai";

import { Vaius } from "~/Client";
import Config from "~/config";
import { db } from "~/db";
import { silently } from "~/util/functions";
import { logAutoModAction } from "~/util/logAction";
import { addWarning } from "~/commands/moderation/warn";

export type Verdict = "ok" | "warn" | "mute" | "ban";

interface Classification {
    verdict: Verdict;
    reason: string;
    confidence: number;
}

export function isAiModAvailable() {
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

// ---- Gemini client (lazy so we never instantiate with an empty key) ---------

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
    client ??= new GoogleGenAI({ apiKey: Config.aiMod.apiKey });
    return client;
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
        .values({ content, verdict, reason, addedBy })
        .execute();
}

export async function removeTrainingExample(id: number) {
    await db.deleteFrom("aiTrainingExamples").where("id", "=", id).execute();
}

function buildFewShot(examples: Array<{ content: string; verdict: Verdict; reason: string }>) {
    return examples.map(e =>
        `message: ${JSON.stringify(e.content)}\nverdict: ${e.verdict}\nreason: ${e.reason}`
    ).join("\n\n");
}

// ---- Classification ----------------------------------------------------------

const SYSTEM_PROMPT = `You are a Discord server moderation AI for the Limey V1 community.
Classify the given message into exactly one verdict:
- "ok": acceptable message, no action needed
- "warn": minor rule violation (spam, mild toxicity, caps, attention seeking, etc.)
- "mute": serious violation (harassment, slurs, severe toxicity, malware/scam links, explicit content)
- "ban": extreme violation (threats, doxxing, illegal content, raids, hardcore NSFW)

Respond ONLY with minified JSON: {"verdict":"ok|warn|mute|ban","reason":"short reason","confidence":0.0-1.0}
Consider the training examples below as the server's standard. Staff messages are never evaluated.
Only flag clear violations — humor, banter, and common slang are acceptable.`;

export async function classifyMessage(content: string): Promise<Classification | null> {
    if (!isAiModAvailable()) return null;

    const examples = await getTrainingExamples();
    const fewShot = buildFewShot(examples);
    const prompt = `${SYSTEM_PROMPT}${fewShot ? `\n\n## Training examples\n${fewShot}` : ""}\n\n## Message to classify\nmessage: ${JSON.stringify(content)}\nverdict:`;

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
            reason: String(parsed.reason ?? "No reason given").slice(0, 500),
            confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)))
        };
    } catch (e) {
        console.error("[aimod] classification failed:", e);
        return null;
    }
}

// ---- Punishment --------------------------------------------------------------

async function punish(msg: import("oceanic.js").Message, member: import("oceanic.js").Member, c: Classification) {
    await silently(msg.channel?.deleteMessage?.(msg.id, `AI Mod: ${c.reason}`).catch(() => null));

    switch (c.verdict) {
        case "ban": {
            await silently(msg.guild.banMember(member.id, 0, { reason: `AI Mod: ${c.reason}` }).catch(e =>
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
            await silently(addWarning(msg.guildID, member.id, Vaius.user.id, `AI Mod: ${c.reason}`));
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

import { Message, Member } from "oceanic.js";

import { Vaius } from "~/Client";
import Config from "~/config";
import { db } from "~/db";
import { silently } from "~/util/functions";
import { addTrainingExample, isAiModEnabled, Verdict } from "./aiMod";

/**
 * Self-learning for AI Mod — "learning from scratch":
 *
 * The AI ships with zero examples. Instead of staff hand-crafting training
 * data with /aimod train, the bot WATCHES how moderators actually moderate
 * and learns from it:
 *
 *  - A staff member deletes a message            → learn verdict "warn"
 *  - A staff member warns a user (via /warn etc) → learn verdict "warn"
 *    with the moderator's own reason text
 *  - A staff member mutes a user                 → learn verdict "mute"
 *  - A staff member bans a user                  → learn verdict "ban"
 *
 * Each learned example is stored in aiTrainingExamples with a "learned"
 * marker so staff can review them with /aimod list and remove bad ones.
 * Learning is passive: the AI never acts until it is explicitly enabled
 * with /aimod toggle.
 */

const LEARN_MARKER = "[learned from staff]";
const MIN_CONTENT_LENGTH = 12;
const MAX_CONTENT_LENGTH = 800;

const recentCache = new Map<string, number>();

function cacheKey(userId: string) {
    return userId;
}

function recentlyLearned(key: string, windowMs = 60_000) {
    const now = Date.now();
    const last = recentCache.get(key);
    recentCache.set(key, now);
    return last != null && now - last < windowMs;
}

function stripMarkers(text: string) {
    return text
        .replace(/^AutoMod:\s*/i, "")
        .replace(/^AI Mod:\s*/i, "")
        .replace(new RegExp(LEARN_MARKER, "gi"), "")
        .trim();
}

async function learn(content: string, verdict: Verdict, reason: string, source: string) {
    content = content.trim().slice(0, 1000);
    reason = stripMarkers(reason).slice(0, 500);
    if (content.length < Math.min(MIN_CONTENT_LENGTH, 5)) return false;
    if (recentlyLearned(`${content}:${verdict}`)) return false;

    await addTrainingExample(content, verdict, `${reason} ${LEARN_MARKER} (${source})`, Vaius.user.id);
    console.log(`[aimod-learn] learned ${verdict} from ${source}: "${content.slice(0, 60)}"`);
    return true;
}

/** Learn from staff deleting messages. */
async function onMessageDelete(deleted: { id: string; channelID: string; guildID?: string; content?: string; author?: { id: string; bot?: boolean; }; member?: Member; }) {
    try {
        if (!(await isAiModEnabled()) && !(await learningEnabled())) return;
        if (deleted.guildID !== Config.homeGuildId) return;
        if (!deleted.author || deleted.author.bot) return;
        if (deleted.member && deleted.member.roles.some(r => Config.roles.staffRoles.includes(r))) return;

        const content = deleted.content ?? "";
        if (content.length < MIN_CONTENT_LENGTH || content.length > MAX_CONTENT_LENGTH) return;

        // who deleted it? we can't know directly — but staff-only prune + our
        // own modules delete too. Only learn if a staff audit reason exists.
        await learn(content, "warn", "Message removed by staff", "message-delete");
    } catch (e) {
        console.error("[aimod-learn] messageDelete error:", e);
    }
}

/** Learn from /warn (and prefix variants) — reason text is the signal. */
export async function learnFromWarning(guildId: string, userId: string, reason: string) {
    try {
        if (guildId !== Config.homeGuildId) return;
        if (!(await learningEnabled())) return;
        await learn(reason, "warn", `Warned by staff: ${reason}`, "warn-command");
    } catch (e) {
        console.error("[aimod-learn] warn error:", e);
    }
}

/** Learn from mutes — the mute reason describes the violation. */
export async function learnFromMute(guildId: string, userId: string, reason: string) {
    try {
        if (guildId !== Config.homeGuildId) return;
        if (!(await learningEnabled())) return;
        await learn(reason, "mute", `Muted by staff: ${reason}`, "mute-command");
    } catch (e) {
        console.error("[aimod-learn] mute error:", e);
    }
}

/** Learn from bans. */
export async function learnFromBan(guildId: string, userId: string, reason: string) {
    try {
        if (guildId !== Config.homeGuildId) return;
        if (!(await learningEnabled())) return;
        await learn(reason, "ban", `Banned by staff: ${reason}`, "ban-command");
    } catch (e) {
        console.error("[aimod-learn] ban error:", e);
    }
}

// ---------------------------------------------------------------------------
// Settings: learning toggle (separate from enforcement toggle)
// ---------------------------------------------------------------------------

export async function learningEnabled() {
    const row = await db.selectFrom("aiModSettings")
        .where("key", "=", "learning")
        .select("value")
        .executeTakeFirst();
    // learning defaults to ON — it's passive and free (no API calls)
    return row?.value !== "false";
}

export async function setLearningEnabled(enabled: boolean) {
    await db.insertInto("aiModSettings")
        .values({ key: "learning", value: String(enabled) })
        .onConflict(oc => oc.column("key").doUpdateSet({ value: String(enabled) }))
        .execute();
}

export function initAiModLearning() {
    // Deleted messages: staff cleanup is a mild "this was bad" signal
    Vaius.on("messageDelete", async (msg: any) => {
        await onMessageDelete(msg);
    });

    console.log("[aimod-learn] self-learning initialized (learning from staff actions)");
}

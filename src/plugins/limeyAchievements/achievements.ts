/*
 * Limey V1, a Discord client mod
 * Copyright (c) 2026 Limey and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BadgeRarity } from "@api/Badges";

/**
 * Every tracked number lives here, so adding an achievement usually only means
 * adding an entry to ACHIEVEMENTS rather than new tracking code.
 */
export interface AchievementStats {
    messagesSent: number;
    charactersTyped: number;
    voiceMinutes: number;
    guildsJoined: number;
    daysActive: number;
    dayStreak: number;
    nightMessages: number;
    earlyMessages: number;
}

export type StatKey = keyof AchievementStats;

export interface Achievement {
    id: string;
    name: string;
    description: string;
    stat: StatKey;
    goal: number;
    icon: string;
    rarity: BadgeRarity;
}

export const STAT_LABELS: Record<StatKey, string> = {
    messagesSent: "messages sent",
    charactersTyped: "characters typed",
    voiceMinutes: "minutes in voice",
    guildsJoined: "servers joined",
    daysActive: "days active",
    dayStreak: "day streak",
    nightMessages: "messages sent between 1am and 5am",
    earlyMessages: "messages sent between 5am and 8am",
};

export const ACHIEVEMENTS: Achievement[] = [
    {
        id: "first-word",
        name: "First Word",
        description: "Send your first message with Limey tracking you.",
        stat: "messagesSent",
        goal: 1,
        icon: "🐣",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "chatterbox",
        name: "Chatterbox",
        description: "Send 100 messages.",
        stat: "messagesSent",
        goal: 100,
        icon: "💬",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "regular",
        name: "Regular",
        description: "Send 1,000 messages.",
        stat: "messagesSent",
        goal: 1_000,
        icon: "📣",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "veteran",
        name: "Veteran",
        description: "Send 10,000 messages.",
        stat: "messagesSent",
        goal: 10_000,
        icon: "🗣️",
        rarity: BadgeRarity.EPIC,
    },
    {
        id: "legend",
        name: "Local Legend",
        description: "Send 50,000 messages.",
        stat: "messagesSent",
        goal: 50_000,
        icon: "🏛️",
        rarity: BadgeRarity.MYTHIC,
    },
    {
        id: "wordsmith",
        name: "Wordsmith",
        description: "Type 10,000 characters.",
        stat: "charactersTyped",
        goal: 10_000,
        icon: "✍️",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "novelist",
        name: "Novelist",
        description: "Type 100,000 characters.",
        stat: "charactersTyped",
        goal: 100_000,
        icon: "📖",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "tome",
        name: "A Whole Tome",
        description: "Type 1,000,000 characters.",
        stat: "charactersTyped",
        goal: 1_000_000,
        icon: "📚",
        rarity: BadgeRarity.MYTHIC,
    },
    {
        id: "mic-check",
        name: "Mic Check",
        description: "Spend a minute in a voice channel.",
        stat: "voiceMinutes",
        goal: 1,
        icon: "🎙️",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "hanging-out",
        name: "Hanging Out",
        description: "Spend 2 hours in voice.",
        stat: "voiceMinutes",
        goal: 120,
        icon: "🔊",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "resident",
        name: "Server Resident",
        description: "Spend 20 hours in voice.",
        stat: "voiceMinutes",
        goal: 1_200,
        icon: "🏠",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "voice-goblin",
        name: "Voice Goblin",
        description: "Spend 100 hours in voice.",
        stat: "voiceMinutes",
        goal: 6_000,
        icon: "🦇",
        rarity: BadgeRarity.EPIC,
    },
    {
        id: "explorer",
        name: "Explorer",
        description: "Be in at least one server.",
        stat: "guildsJoined",
        goal: 1,
        icon: "🧭",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "socialite",
        name: "Socialite",
        description: "Be in 5 servers.",
        stat: "guildsJoined",
        goal: 5,
        icon: "🌍",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "networker",
        name: "Networker",
        description: "Be in 25 servers.",
        stat: "guildsJoined",
        goal: 25,
        icon: "🛰️",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "cartographer",
        name: "Cartographer",
        description: "Be in 100 servers.",
        stat: "guildsJoined",
        goal: 100,
        icon: "🗺️",
        rarity: BadgeRarity.MYTHIC,
    },
    {
        id: "day-one",
        name: "Day One",
        description: "Open Discord with Limey on one day.",
        stat: "daysActive",
        goal: 1,
        icon: "🌱",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "week-one",
        name: "One Week In",
        description: "Use Limey on 7 different days.",
        stat: "daysActive",
        goal: 7,
        icon: "📅",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "month-one",
        name: "One Month In",
        description: "Use Limey on 30 different days.",
        stat: "daysActive",
        goal: 30,
        icon: "🌙",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "hundred-days",
        name: "Century Club",
        description: "Use Limey on 100 different days.",
        stat: "daysActive",
        goal: 100,
        icon: "🏅",
        rarity: BadgeRarity.EPIC,
    },
    {
        id: "year-one",
        name: "Happy Anniversary",
        description: "Use Limey on 365 different days.",
        stat: "daysActive",
        goal: 365,
        icon: "🎂",
        rarity: BadgeRarity.MYTHIC,
    },
    {
        id: "hot-streak",
        name: "Warming Up",
        description: "Use Limey 3 days in a row.",
        stat: "dayStreak",
        goal: 3,
        icon: "🔥",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "week-streak",
        name: "On Fire",
        description: "Use Limey 7 days in a row.",
        stat: "dayStreak",
        goal: 7,
        icon: "🔥",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "month-streak",
        name: "Unstoppable",
        description: "Use Limey 30 days in a row.",
        stat: "dayStreak",
        goal: 30,
        icon: "🌋",
        rarity: BadgeRarity.MYTHIC,
    },
    {
        id: "night-owl",
        name: "Night Owl",
        description: "Send a message between 1am and 5am.",
        stat: "nightMessages",
        goal: 1,
        icon: "🦉",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "night-shift",
        name: "Night Shift",
        description: "Send 50 messages between 1am and 5am.",
        stat: "nightMessages",
        goal: 50,
        icon: "🌃",
        rarity: BadgeRarity.RARE,
    },
    {
        id: "early-bird",
        name: "Early Bird",
        description: "Send a message between 5am and 8am.",
        stat: "earlyMessages",
        goal: 1,
        icon: "🌅",
        rarity: BadgeRarity.COMMON,
    },
    {
        id: "sunrise-crew",
        name: "Sunrise Crew",
        description: "Send 50 messages between 5am and 8am.",
        stat: "earlyMessages",
        goal: 50,
        icon: "☀️",
        rarity: BadgeRarity.RARE,
    },
];

export const LEVEL_CAP = 100;

const LEVEL_TITLES: { minLevel: number; title: string; }[] = [
    { minLevel: 75, title: "Lime Deity" },
    { minLevel: 50, title: "Lime Legend" },
    { minLevel: 35, title: "Lime Captain" },
    { minLevel: 20, title: "Lime Ranger" },
    { minLevel: 10, title: "Lime Scout" },
    { minLevel: 5, title: "Sapling" },
    { minLevel: 1, title: "Sprout" },
];

export function statValue(achievement: Achievement, stats: AchievementStats): number {
    return stats[achievement.stat] ?? 0;
}

export function isAchieved(achievement: Achievement, stats: AchievementStats): boolean {
    return statValue(achievement, stats) >= achievement.goal;
}

export function achievementPercent(achievement: Achievement, stats: AchievementStats): number {
    if (achievement.goal <= 0) return 100;
    return Math.min(100, Math.floor(statValue(achievement, stats) / achievement.goal * 100));
}

/**
 * XP is derived from the stats rather than stored, so the level can never drift
 * out of sync with the numbers the achievements are based on.
 */
export function totalXp(stats: AchievementStats, unlockedCount: number): number {
    return stats.messagesSent
        + Math.floor(stats.charactersTyped / 50)
        + stats.voiceMinutes * 2
        + stats.guildsJoined * 25
        + stats.daysActive * 10
        + Math.min(stats.dayStreak, 365) * 15
        + unlockedCount * 50;
}

/** XP needed to have reached `level` (level 1 starts at 0). */
function xpToReachLevel(level: number): number {
    return 100 * (level - 1) * level / 2;
}

export function levelFromXp(xp: number): number {
    let level = 1;
    while (level < LEVEL_CAP && xp >= xpToReachLevel(level + 1)) {
        level++;
    }
    return level;
}

export function levelProgress(xp: number): { level: number; into: number; needed: number; percent: number; } {
    const level = levelFromXp(xp);
    if (level >= LEVEL_CAP) {
        return { level, into: 0, needed: 0, percent: 100 };
    }

    const base = xpToReachLevel(level);
    const needed = xpToReachLevel(level + 1) - base;
    const into = Math.max(0, Math.min(needed, xp - base));

    return {
        level,
        into,
        needed,
        percent: Math.floor(into / needed * 100),
    };
}

export function titleForLevel(level: number): string {
    return LEVEL_TITLES.find(t => level >= t.minLevel)?.title ?? "Sprout";
}

export function formatNumber(value: number): string {
    if (value < 1_000) return String(value);
    if (value < 1_000_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
}

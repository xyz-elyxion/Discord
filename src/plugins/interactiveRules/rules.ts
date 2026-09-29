/*
 * Limey V1 — InteractiveRules plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RULES_CHANNEL_ID = "1553937108107006043";

export const RULES_PAGE_URL = "https://limey-discord.onrender.com/rules.html";

export interface Rule {
    num: number;
    title: string;
    category: "Conduct" | "Community" | "Security" | "Development" | "Content" | "Server" | "Legal";
    summary: string;
    details: string[];
}

export const RULES: Rule[] = [
    {
        num: 1,
        title: "Respect & Professional Conduct",
        category: "Conduct",
        summary: "Communicate respectfully and professionally at all times.",
        details: [
            "No harassment, bullying, intimidation, or personal attacks.",
            "No discrimination based on race, nationality, gender, religion, disability, or any other protected characteristic.",
            "No excessive hostility, unnecessary arguments, or attempts to provoke conflict.",
            "No targeting individuals or groups with malicious intent.",
            "Constructive criticism and disagreements are welcome when expressed respectfully."
        ]
    },
    {
        num: 2,
        title: "Community Integrity",
        category: "Community",
        summary: "Contribute positively — no deception or drama.",
        details: [
            "Don't intentionally spread misinformation.",
            "Don't impersonate developers, staff members, or other users.",
            "Don't attempt to manipulate, deceive, or mislead community members.",
            "Don't create unnecessary drama or conflicts."
        ]
    },
    {
        num: 3,
        title: "Security & Safety",
        category: "Security",
        summary: "No malware, scams, or credential theft. Protect users.",
        details: [
            "No malware, viruses, token stealers, credential theft tools, or malicious code.",
            "No sharing suspicious files, links, or downloads.",
            "No requesting passwords, authentication tokens, private keys, or personal information.",
            "No attempts to compromise accounts, systems, or services.",
            "Report security issues privately to the moderation or development team."
        ]
    },
    {
        num: 4,
        title: "Plugins, Modifications & Development",
        category: "Development",
        summary: "Build freely — but never enable abuse or violate Discord's ToS.",
        details: [
            "Projects must not enable abuse, spam, harassment, or malicious automation.",
            "No facilitating account compromise or unauthorized access.",
            "No violating Discord's Terms of Service.",
            "No hidden functionality or undisclosed tracking.",
            "Provide clear documentation, credit third-party work, follow licenses, and submit responsible bug reports."
        ]
    },
    {
        num: 5,
        title: "Content Guidelines",
        category: "Content",
        summary: "Keep all content appropriate for a general audience.",
        details: [
            "No NSFW or sexually explicit material.",
            "No graphic violence or disturbing content.",
            "No illegal content or instructions facilitating illegal activity.",
            "No hate speech or extremist material.",
            "No excessive profanity or inappropriate content."
        ]
    },
    {
        num: 6,
        title: "Advertising & Promotion",
        category: "Server",
        summary: "No unsolicited ads or invites. Partnerships need staff approval.",
        details: [
            "Don't advertise other servers, products, services, or websites without permission.",
            "No unsolicited advertisements through direct messages.",
            "No promoting unrelated projects in support channels.",
            "Partnerships and collaborations must be approved by staff."
        ]
    },
    {
        num: 7,
        title: "Channel Usage",
        category: "Server",
        summary: "Use channels for their intended purpose.",
        details: [
            "Read channel descriptions before posting.",
            "Keep discussions relevant.",
            "Avoid posting support requests in unrelated channels.",
            "Avoid excessive mentions or unnecessary notifications."
        ]
    },
    {
        num: 8,
        title: "Support Guidelines",
        category: "Server",
        summary: "Ask well — provide details, logs, and steps to reproduce.",
        details: [
            "Provide a clear description of the issue.",
            "Include relevant error messages or logs.",
            "Include steps to reproduce the problem.",
            "Include system information when necessary.",
            "Remain patient — community members and staff volunteer their time."
        ]
    },
    {
        num: 9,
        title: "Bug Reports & Feedback",
        category: "Development",
        summary: "Quality feedback only — no duplicates or false reports.",
        details: [
            "Confirm the issue exists before submitting reports.",
            "Avoid duplicate reports.",
            "Provide accurate information.",
            "Do not intentionally submit false reports.",
            "Feature suggestions are welcome but may not always be implemented."
        ]
    },
    {
        num: 10,
        title: "Privacy & Personal Information",
        category: "Security",
        summary: "Respect everyone's privacy — never share private data.",
        details: [
            "Never share personal information.",
            "Never share private conversations without consent.",
            "Never share account credentials.",
            "Never share private files or data belonging to others.",
            "Don't attempt to collect personal information from community members."
        ]
    },
    {
        num: 11,
        title: "Moderation Policy",
        category: "Community",
        summary: "Staff may warn, restrict, mute, or ban based on context and severity.",
        details: [
            "Possible actions: warnings, message removal, temporary restrictions, temporary bans, permanent bans.",
            "Decisions are based on context, severity, and previous behaviour.",
            "If you believe an action was incorrect, contact staff privately through the appropriate channels."
        ]
    },
    {
        num: 12,
        title: "Discord Terms of Service",
        category: "Legal",
        summary: "Follow Discord's ToS, Community Guidelines, and applicable laws.",
        details: [
            "Follow the Discord Terms of Service.",
            "Follow the Discord Community Guidelines.",
            "Follow applicable laws and regulations.",
            "Breaking Discord's rules may result in removal from the community."
        ]
    }
];

export const CATEGORIES = ["All", "Conduct", "Community", "Security", "Development", "Content", "Server", "Legal"] as const;

import { ApplicationCommandOptionTypes } from "oceanic.js";

import {
    addTrainingExample,
    classifyMessage,
    getTrainingExamples,
    isAiModAvailable,
    isAiModEnabled,
    removeTrainingExample,
    setAiModEnabled,
    Verdict
} from "~/modules/moderation/aiMod";
import { learningEnabled, setLearningEnabled } from "~/modules/moderation/aiModLearning";
import Config from "~/config";
import { registerChatInputCommand } from "~/SlashCommands";

const VERDICT_CHOICES = [
    { name: "ok — no action", value: "ok" },
    { name: "warn — minor violation", value: "warn" },
    { name: "mute — serious violation", value: "mute" },
    { name: "ban — extreme violation", value: "ban" },
];

registerChatInputCommand(
    {
        name: "aimod",
        description: "Manage the trainable AI moderation system",
        options: [
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "toggle",
            description: "Enable or disable AI moderation",
            options: [{
                type: ApplicationCommandOptionTypes.BOOLEAN,
                name: "enabled",
                description: "Whether AI moderation should be active",
                required: true
            }]
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "train",
            description: "Teach the AI how to classify a message",
            options: [
                {
                    type: ApplicationCommandOptionTypes.STRING,
                    name: "content",
                    description: "The example message",
                    required: true
                },
                {
                    type: ApplicationCommandOptionTypes.STRING,
                    name: "verdict",
                    description: "What the AI should decide for this message",
                    choices: VERDICT_CHOICES,
                    required: true
                },
                {
                    type: ApplicationCommandOptionTypes.STRING,
                    name: "reason",
                    description: "Why this verdict applies",
                    required: true
                },
            ]
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "remove",
            description: "Remove a training example by id",
            options: [{
                type: ApplicationCommandOptionTypes.INTEGER,
                name: "id",
                description: "The id of the training example (see /aimod list)",
                required: true
            }]
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "list",
            description: "List all training examples"
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "test",
            description: "Classify a sample message without taking action",
            options: [{
                type: ApplicationCommandOptionTypes.STRING,
                name: "content",
                description: "The message to classify",
                required: true
            }]
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "status",
            description: "Show AI moderation status"
        },
        {
            type: ApplicationCommandOptionTypes.SUB_COMMAND,
            name: "learning",
            description: "Toggle self-learning from staff moderation actions",
            options: [{
                type: ApplicationCommandOptionTypes.BOOLEAN,
                name: "enabled",
                description: "Whether the AI should learn from staff actions",
                required: true
            }]
        },
        ]
    },
    {
        guildOnly: true,
        allowedRoles: Config.roles.staffRoles,
        async handle(interaction) {
        const sub = interaction.data.options.getSubCommand()![0];

        if (!isAiModAvailable()) {
            const enabled = await isAiModEnabled().catch(() => false);
            if (sub !== "status" && sub !== "list" && sub !== "remove" && sub !== "train") {
                return void interaction.createMessage({
                    content: "❌ AI moderation is not configured. Set the `GEMINI_API_KEY` environment variable (or config `aiMod.apiKey`) and restart.",
                    flags: 64
                });
            }
            if (sub === "status" && !enabled) {
                // fall through: status should still work without a key
            }
        }

        switch (sub) {
            case "toggle": {
                if (!isAiModAvailable())
                    return void interaction.createMessage({
                        content: "❌ Cannot enable: no API key configured. Set the `GEMINI_API_KEY` environment variable first.",
                        flags: 64
                    });

                const enabled = interaction.data.options.getBoolean("enabled", true)!;
                await setAiModEnabled(enabled);
                return void interaction.createMessage({
                    content: `✅ AI moderation is now **${enabled ? "enabled" : "disabled"}**.`,
                    flags: 64
                });
            }

            case "train": {
                const content = interaction.data.options.getString("content", true)!;
                const verdict = interaction.data.options.getString("verdict", true)! as Verdict;
                const reason = interaction.data.options.getString("reason", true)!;

                await addTrainingExample(content.slice(0, 1000), verdict, reason.slice(0, 500), interaction.user.id);
                const count = (await getTrainingExamples()).length;
                return void interaction.createMessage({
                    content: `🧠 Training example added (**${count}** total). The AI uses these as few-shot examples on every classification.`,
                    flags: 64
                });
            }

            case "remove": {
                const id = interaction.data.options.getInteger("id", true)!;
                await removeTrainingExample(id);
                return void interaction.createMessage({ content: `🗑️ Removed training example #${id}.`, flags: 64 });
            }

            case "list": {
                const examples = await getTrainingExamples();
                if (!examples.length)
                    return void interaction.createMessage({
                        content: "No training examples yet. Use `/aimod train` to teach the AI.",
                        flags: 64
                    });

                const lines = examples.map(e =>
                    `\`#${e.id}\` **${e.verdict}** — ${e.content.slice(0, 80).replace(/\n/g, " ")} → ${e.reason.slice(0, 80)}`
                );
                return void interaction.createMessage({
                    content: `**${examples.length} training example(s):**\n${lines.slice(0, 25).join("\n")}` +
                        (lines.length > 25 ? `\n*…and ${lines.length - 25} more*` : ""),
                    flags: 64
                });
            }

            case "test": {
                const content = interaction.data.options.getString("content", true)!;
                await interaction.defer(64);
                const result = await classifyMessage(content);
                if (!result)
                    return void interaction.createFollowup({ content: "❌ Classification failed (no API key or API error). Check the logs." });

                return void interaction.createFollowup({
                    content: `🤖 **Verdict:** \`${result.verdict}\`\n**Confidence:** ${result.confidence.toFixed(2)}\n**Reason:** ${result.reason}`
                });
            }

            case "learning": {
                const on = interaction.data.options.getBoolean("enabled", true)!;
                await setLearningEnabled(on);
                return void interaction.createMessage({
                    content: `🧠 Self-learning is now **${on ? "on" : "off"}**. ${on ? "The AI will build its training data by watching how staff warn/mute/ban and delete messages." : ""}`,
                    flags: 64
                });
            }

            case "status": {
                const available = isAiModAvailable();
                const enabled = await isAiModEnabled().catch(() => false);
                const learning = await learningEnabled().catch(() => true);
                const examples = await getTrainingExamples();
                const learned = examples.filter(e => e.reason.includes("[learned from staff]")).length;
                return void interaction.createMessage({
                    content: [
                        "**AI Moderation status**",
                        `API key: ${available ? "✅ configured" : "❌ missing (set GEMINI_API_KEY)"}`,
                        `Enabled: ${enabled ? "✅ on" : "❌ off"}`,
                        `Self-learning: ${learning ? "✅ on" : "❌ off"} (${learned} auto-learned examples)`,
                        `Model: \`${Config.aiMod.model}\``,
                        `Confidence threshold: ${Config.aiMod.confidenceThreshold}`,
                        `Training examples: **${examples.length}**`,
                    ].join("\n"),
                    flags: 64
                });
            }
        }
        }
    }
);

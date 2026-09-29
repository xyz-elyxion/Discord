/*
 * Limey V1, a modification for Discord's desktop app
 * Copyright (c) 2022 Limey and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

// Deterministic 8-ball answers: 10 positive, 5 neutral, 5 negative (like the real toy)
const ANSWERS = [
    // Positive
    "It is certain",
    "It is decidedly so",
    "Without a doubt",
    "Yes definitely",
    "You may rely on it",
    "As I see it, yes",
    "Most likely",
    "Outlook good",
    "Yes",
    "Signs point to yes",
    // Neutral
    "Reply hazy, try again",
    "Ask again later",
    "Better not tell you now",
    "Cannot predict now",
    "Concentrate and ask again",
    // Negative
    "Don't count on it",
    "My reply is no",
    "My sources say no",
    "Outlook not so good",
    "Very doubtful",
];

function hash(str: string) {
    // FNV-1a — deterministic so the same question always gets the same answer
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export default definePlugin({
    name: "MagicEightBall",
    description: "Adds an /8ball command that answers yes/no questions with a deterministic magic 8-ball",
    tags: ["Fun", "Commands"],
    authors: [Devs.Limey],
    permissions: [
        {
            id: "registerCommands",
            title: "Register chat commands",
            description: "Adds the /8ball slash command.",
            risk: "The command reads the question text you type into it."
        },
        {
            id: "sendMessage",
            title: "Send messages on your behalf",
            description: "Posts the 8-ball's answer as a bot-style reply in the channel.",
            risk: "The answer message is sent in your name to the current channel."
        }
    ],
    commands: [
        {
            name: "8ball",
            description: "Ask the magic 8-ball a yes/no question",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "question",
                    description: "Your yes/no question",
                    type: 3 /* STRING */,
                    required: true
                }
            ],
            execute(opts, { channel }) {
                const question = opts[0]?.value as string;
                if (!question?.trim())
                    return sendBotMessage(channel.id, { content: "You need to actually ask something." });

                const answer = ANSWERS[hash(question.trim().toLowerCase()) % ANSWERS.length];

                return sendBotMessage(channel.id, {
                    content: `🎱 **${answer}**`
                });
            }
        }
    ]
});

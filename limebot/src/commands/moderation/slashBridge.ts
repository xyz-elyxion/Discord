import { bridgeSlashCommand } from "~/SlashCommands";

/**
 * Registers slash-command versions of prefix commands.
 *
 * Each entry maps the slash options back into the string args that the
 * prefix executor expects. Executors were written for prefix parsing, so
 * multi-user "user [user...]" commands are bridged with a single user option
 * (the executor's own arg parser handles the rest).
 */

// ---- moderation ----

bridgeSlashCommand("ban", [
    { type: "int", name: "days", description: "Days of messages to delete (0-7)", required: false, min: 0, max: 7 },
    { type: "user", name: "user", description: "User to ban", required: true },
    { type: "raw", name: "reason", description: "Reason (mention additional users inside)" },
]);

bridgeSlashCommand("softban", [
    { type: "int", name: "days", description: "Days of messages to delete (1-7)", required: true, min: 1, max: 7 },
    { type: "user", name: "user", description: "User to softban", required: true },
    { type: "raw", name: "reason", description: "Reason" },
]);

bridgeSlashCommand("kick", [
    { type: "user", name: "user", description: "User to kick", required: true },
    { type: "raw", name: "reason", description: "Reason" },
]);

bridgeSlashCommand("mute", [
    { type: "string", name: "duration", description: "Duration, e.g. 10m, 2h, 3d (max 28d)", required: true },
    { type: "user", name: "user", description: "User to mute", required: true },
    { type: "raw", name: "reason", description: "Reason" },
]);

bridgeSlashCommand("tempban", [
    { type: "string", name: "duration", description: "Duration, e.g. 1h, 3d (max 30d)", required: true },
    { type: "user", name: "user", description: "User to temp-ban", required: true },
    { type: "raw", name: "reason", description: "Reason" },
]);

bridgeSlashCommand("unban", [
    { type: "string", name: "user", description: "User ID to unban", required: true },
    { type: "raw", name: "reason", description: "Reason" },
]);

bridgeSlashCommand("warn", [
    { type: "user", name: "user", description: "User to warn", required: true },
    { type: "raw", name: "reason", description: "Reason", required: false },
]);

bridgeSlashCommand("warnings", [
    { type: "user", name: "user", description: "User whose warnings to view", required: true },
]);

bridgeSlashCommand("delwarn", [
    { type: "int", name: "id", description: "Warning ID to delete", required: true, min: 1 },
]);

bridgeSlashCommand("slowmode", [
    { type: "int", name: "seconds", description: "Slowmode in seconds (0 = off, max 21600)", required: true, min: 0, max: 21600 },
]);

bridgeSlashCommand("set-name", [
    { type: "raw", name: "value", description: "New channel name", required: true },
]);

bridgeSlashCommand("set-topic", [
    { type: "raw", name: "value", description: "New channel topic", required: true },
]);

bridgeSlashCommand("submissionpass", [
    { type: "user", name: "user", description: "User to grant a submission pass", required: true },
]);

bridgeSlashCommand("removesubmissionpass", [
    { type: "user", name: "user", description: "User to remove the submission pass from", required: true },
]);

bridgeSlashCommand("threads", [
    { type: "string", name: "action", description: "watch / unwatch / list", required: false },
    { type: "channel", name: "channel", description: "Thread or channel", required: false },
]);

bridgeSlashCommand("unbanme", []);
bridgeSlashCommand("whyBanne", [{ type: "user", name: "user", description: "User to look up", required: true }]);

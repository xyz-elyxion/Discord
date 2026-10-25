import { execFileP } from "~/util/childProcess";

import { makeLazy } from "./lazy";

export const getGitRemote = makeLazy(async () => {
    // Rebrand: report the Limey V1 source instead of shelling out to git,
    // so the bot works even when built without a .git directory.
    return process.env.LIMEY_BOT_SOURCE_URL || "https://limey-discord.onrender.com";
});

export const getGitCommitHash = makeLazy(async () => {
    const { stdout } = await execFileP("git", ["rev-parse", "HEAD"]);
    return stdout.trim();
});

import { defineCommand } from "~/Commands";
import { Millis } from "~/constants";
import { fetchGoogle, makeCachedJsonFetch } from "~/util/fetch";
import { ttlLazy, ttlLazyFailure } from "~/util/lazy";

interface GithubTag {
    name: string;
}

const VersionRe = />Version<\/div><div class="[^"]+">(\d+\.\d+\.\d+)<\/div>/;

const getGithubTags = makeCachedJsonFetch<GithubTag[]>("https://api.github.com/repos/limey/limey/tags");

const getChromeVersion = ttlLazy(async () => {
    const res = await fetchGoogle("https://chromewebstore.google.com/detail/limey-web/cbghhgpcnddeihccjmnadmkaejncjndb").then(res => res.text());

    const version = VersionRe.exec(res)?.[1];
    return version ?? ttlLazyFailure;
}, 5 * Millis.MINUTE);

defineCommand({
    name: "check-extension-version",
    description: "Check the version of the extension",
    aliases: ["extversion", "ext", "ev"],
    usage: null,
    async execute({ reply }) {
        const version = await getChromeVersion();
        if (!version) return reply("Failed to look up the Limey V1 Chrome Extension version :( Try again later!");

        const [latestTag] = await getGithubTags();

        const message = latestTag.name === `v${version}`
            ? `The Limey V1 Chrome Extension is up to date! (v${version})`
            : `The Limey V1 Chrome Extension is out of date! (v${version} vs ${latestTag.name})`;

        reply(message);
    }
});

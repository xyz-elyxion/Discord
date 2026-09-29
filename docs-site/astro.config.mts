import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import starlightLlmsTxt from "starlight-llms-txt";

// https://astro.build/config
export default defineConfig({
    site: "https://limey-discord.onrender.com",
    base: "/docs",
    integrations: [
        starlight({
            plugins: [starlightLlmsTxt()],
            title: "Limey V1 Docs",
            logo: {
                src: "./src/assets/limey-logo.png"
            },
            favicon: "favicon.png",
            editLink: {
                baseUrl: "https://github.com/xyz-elyxion/Discord/tree/main/"
            },
            social: [
                { icon: "github", href: "https://github.com/xyz-elyxion/Discord", label: "GitHub" },
                { icon: "discord", href: "https://discord.gg/your-invite", label: "Discord" }
            ],
            customCss: ["./src/style/custom.css", "./src/style/headingLinks.css"],
            lastUpdated: true,
            sidebar: [
                {
                    label: "Introduction",
                    link: "/intro"
                },
                {
                    label: "Installation & Preparation",
                    items: [{ autogenerate: { directory: "installing" } }]
                },
                {
                    label: "Plugin Development",
                    items: [{ autogenerate: { directory: "plugins" } }]
                },
                {
                    label: "Navigating Discord's Code",
                    items: [{ autogenerate: { directory: "discord-code" } }]
                }
            ]
        })
    ],
    vite: {
        assetsInclude: ["src/assets/**/*"]
    }
});

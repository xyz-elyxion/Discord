/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BuildContext, BuildOptions, context } from "esbuild";
import { copyFile } from "fs/promises";

import limeyDep from "./limeyDep.mjs";
import { includeDirPlugin } from "./includeDirPlugin.mts";

const isDev = process.argv.includes("--dev");

const CommonOpts: BuildOptions = {
    minify: !isDev,
    bundle: true,
    sourcemap: "linked",
    logLevel: "info"
};

const NodeCommonOpts: BuildOptions = {
    ...CommonOpts,
    format: "cjs",
    platform: "node",
    external: ["electron"],
    target: ["esnext"],
    loader: {
        ".node": "file"
    },
    define: {
        IS_DEV: JSON.stringify(isDev)
    }
};

const contexts = [] as BuildContext[];
async function createContext(options: BuildOptions) {
    contexts.push(await context(options));
}

async function copyVenmic() {
    if (process.platform !== "linux") return;

    return Promise.all([
        copyFile(
            "./node_modules/@vencord/venmic/prebuilds/venmic-addon-linux-x64/node-napi-v7.node",
            "./static/dist/venmic-x64.node"
        ),
        copyFile(
            "./node_modules/@vencord/venmic/prebuilds/venmic-addon-linux-arm64/node-napi-v7.node",
            "./static/dist/venmic-arm64.node"
        )
    ]).catch(() => console.warn("Failed to copy venmic. Building without venmic support"));
}

async function copyLibLimeyDesktop() {
    if (process.platform !== "linux") return;

    try {
        await copyFile(
            "./packages/liblimey/build/Release/liblimey.node",
            `./static/dist/liblimey-${process.arch}.node`
        );
        console.log("Using local liblimey build");
    } catch {
        console.log(
            "Using prebuilt liblimey binaries. Run `pnpm buildLibLimey` and build again to build from source - see README.md for more details"
        );
        return Promise.all([
            copyFile("./packages/liblimey/prebuilds/liblimey-x64.node", "./static/dist/libliblimey-x64.node"),
            copyFile("./packages/liblimey/prebuilds/liblimey-arm64.node", "./static/dist/libliblimey-arm64.node")
        ]).catch(() => console.warn("Failed to copy liblimey. Building without liblimey support"));
    }
}

await Promise.all([
    copyVenmic(),
    copyLibLimeyDesktop(),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/main/index.ts"],
        outfile: "dist/js/main.js",
        footer: { js: "//# sourceURL=Limey V1 DesktopMain" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/main/arrpc/worker.ts"],
        outfile: "dist/js/arRpcWorker.js",
        footer: { js: "//# sourceURL=Limey V1 DesktopArRpcWorker" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/index.ts"],
        outfile: "dist/js/preload.js",
        footer: { js: "//# sourceURL=Limey V1 DesktopPreload" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/splash.ts"],
        outfile: "dist/js/splashPreload.js",
        footer: { js: "//# sourceURL=Limey V1 DesktopSplashPreload" }
    }),
    createContext({
        ...NodeCommonOpts,
        entryPoints: ["src/preload/updater.ts"],
        outfile: "dist/js/updaterPreload.js",
        footer: { js: "//# sourceURL=Limey V1 DesktopUpdaterPreload" }
    }),
    createContext({
        ...CommonOpts,
        globalName: "LimeyV1Desktop",
        entryPoints: ["src/renderer/index.ts"],
        outfile: "dist/js/renderer.js",
        format: "iife",
        inject: ["./scripts/build/injectReact.mjs"],
        jsxFactory: "LimeyV1CreateElement",
        jsxFragment: "LimeyV1Fragment",
        external: ["@vencord/types/*"],
        plugins: [limeyDep, includeDirPlugin("patches", "src/renderer/patches")],
        footer: { js: "//# sourceURL=Limey V1 DesktopRenderer" }
    })
]);

const watch = process.argv.includes("--watch");

if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
    await Promise.all(
        contexts.map(async ctx => {
            await ctx.rebuild();
            await ctx.dispose();
        })
    );
}

/*
 * Limey V1 Desktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2025 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, protocol } from "electron";

import { handleLimeyV1AssetsProtocol } from "./userAssets";
import { handleLimeyV1StaticProtocol } from "./limeyStatic";

app.whenReady().then(() => {
    protocol.handle("limey", async req => {
        const url = new URL(req.url);

        switch (url.hostname) {
            case "assets":
                return handleLimeyV1AssetsProtocol(url.pathname, req);
            case "static":
                return handleLimeyV1StaticProtocol(url.pathname, req);
            default:
                return new Response(null, { status: 404 });
        }
    });
});

protocol.registerSchemesAsPrivileged([
    {
        scheme: "limey",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true
        }
    }
]);

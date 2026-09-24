/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

package main

import (
	"os"
	"vencordinstaller/buildinfo"
)

// Limey V1 builds are served by the Limey backend instead of GitHub releases.
// BASE_URL may be overridden via env for local development.
var BaseUrl = getEnv("LIMEY_INSTALLER_BASE_URL", "https://limey-discord.onrender.com")

// Files the installer downloads/updates. Served at <BaseUrl>/v1/install/files/<name>.
var BuildFiles = []string{
	"patcher.js",
	"preload.js",
	"renderer.js",
	"renderer.css",
}

var UserAgent = "LimeyV1Installer/" + buildinfo.InstallerGitHash

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

var LinuxDiscordNames = []string{
	"Discord",
	"DiscordPTB",
	"DiscordCanary",
	"DiscordDevelopment",
	"discord",
	"discordptb",
	"discordcanary",
	"discorddevelopment",
	"discord-ptb",
	"discord-canary",
	"discord-development",
	// Flatpak
	"com.discordapp.Discord",
	"com.discordapp.DiscordPTB",
	"com.discordapp.DiscordCanary",
	"com.discordapp.DiscordDevelopment",
}

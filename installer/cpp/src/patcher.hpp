/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include "discord.hpp"

#include <string>

// app.asar swapping, ported from installer/patcher.go.
namespace patcher {

// Both return "" on success, a human-readable error otherwise. `install` is
// updated in place (is_patched) exactly like the Go methods did.
std::string patch(DiscordInstall& install);
std::string unpatch(DiscordInstall& install);

// The raw primitives, exported because patching a second install re-uses them.
std::string patch_app_asar(const std::string& dir, bool is_system_electron);
std::string unpatch_app_asar(const std::string& dir, bool is_system_electron);

} // namespace patcher

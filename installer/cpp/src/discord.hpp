/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <optional>
#include <string>
#include <vector>

// One detected Discord installation. Field names mirror the Go struct so the
// patching code reads the same way as installer/patcher.go did.
struct DiscordInstall {
    std::string path;  // the base path
    std::string branch; // canary / stable / ...
    std::string app_path; // app folder inside resources
    bool is_patched = false;
    bool is_flatpak = false;
    bool is_system_electron = false; // https://aur.archlinux.org/packages/discord_arch_electron
};

namespace discord {

// "stable" unless the name ends in canary/development/ptb.
std::string get_branch(const std::string& name);

// Linux: resolves SUDO_USER/DOAS_USER and points HOME at the real user's home
// so the installer writes into the right profile when run through sudo.
// No-op everywhere else.
void init_environment();

std::vector<DiscordInstall> find_discords();

// Parses an install at an explicit path (resources/ layout, or the
// app.asar-only layout of system-electron packages). nullopt when the path is
// not a Discord install.
std::optional<DiscordInstall> parse_discord(const std::string& path, const std::string& branch);

// Parses the app-<version>/resources layout used by the ~/.config/discord
// style installs and by flatpak.
std::optional<DiscordInstall> parse_discord_new(const std::string& path,
                                                const std::string& branch,
                                                bool is_flatpak);

// Windows closes Discord before patching; Linux/macOS do nothing.
void prepare_patch(const DiscordInstall& install);

// Linux chowns the files back to SUDO_USER when running as root. Returns ""
// on success.
std::string fix_ownership(const std::string& path);

// The Windows "%PROGRAMDATA%\<user>\Discord" broken-install check.
bool check_scuffed_install();

// CLI wording of the broken-install warning (the GUI showed a modal).
void handle_scuffed_install();

} // namespace discord

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

// macOS Discord discovery, ported from installer/find_discord_darwin.go.

#include "discord.hpp"

#include "log.hpp"
#include "util.hpp"

#if defined(__APPLE__)

#include <filesystem>
#include <string>
#include <vector>

namespace discord {
namespace {

struct BranchName {
    const char* branch;
    const char* dir_name;
};

const BranchName k_macos_names[] = {
    {"stable", "Discord.app"},
    {"ptb", "Discord PTB.app"},
    {"canary", "Discord Canary.app"},
    {"development", "Discord Development.app"},
};

} // namespace

void init_environment() {}

std::optional<DiscordInstall> parse_discord_new(const std::string&, const std::string&, bool) {
    return std::nullopt;
}

std::optional<DiscordInstall> parse_discord(const std::string& path, const std::string& branch) {
    if (!util::exists_file(path)) {
        return std::nullopt;
    }

    const std::string resources = util::join(path, "Contents/Resources");
    if (!util::exists_file(resources)) {
        return std::nullopt;
    }

    std::string resolved_branch = branch;
    if (resolved_branch.empty()) {
        std::string stripped = path;
        if (util::ends_with(stripped, ".app")) {
            stripped.resize(stripped.size() - 4);
        }
        resolved_branch = get_branch(stripped);
    }

    DiscordInstall install;
    install.path = path;
    install.branch = resolved_branch;
    install.app_path = util::join(resources, "app");
    install.is_patched = util::exists_file(util::join(resources, "_app.asar"));
    install.is_flatpak = false;
    install.is_system_electron = false;
    return install;
}

std::vector<DiscordInstall> find_discords() {
    std::vector<DiscordInstall> found;

    const std::vector<std::string> bases = {
        "/Applications",
        util::join(util::get_env("HOME"), "Applications"),
    };

    for (const auto& entry : k_macos_names) {
        for (const auto& base : bases) {
            const std::string path = util::join(base, entry.dir_name);
            if (auto install = parse_discord(path, entry.branch); install.has_value()) {
                logging::debug("Found Discord Install at " + path);
                found.push_back(*install);
            }
        }
    }
    return found;
}

void prepare_patch(const DiscordInstall&) {}

std::string fix_ownership(const std::string&) {
    return "";
}

bool check_scuffed_install() {
    return false;
}

} // namespace discord

#endif // __APPLE__

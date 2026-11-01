/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

// Linux (and other unixes) Discord discovery, ported from
// installer/find_discord_linux.go.

#include "discord.hpp"

#include "log.hpp"
#include "util.hpp"

#if !defined(_WIN32) && !defined(__APPLE__)

#include <pwd.h>
#include <unistd.h>

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

namespace discord {
namespace {

const char* k_linux_discord_names[] = {
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
};

bool list_contains(const char* const* items, std::size_t count, const std::string& needle) {
    for (std::size_t i = 0; i < count; ++i) {
        if (needle == items[i]) {
            return true;
        }
    }
    return false;
}

} // namespace

void init_environment() {
    // If run as root, HOME is root's. SUDO_USER/DOAS_USER name the real user.
    std::string sudo_user = util::get_env("SUDO_USER");
    if (sudo_user.empty()) {
        sudo_user = util::get_env("DOAS_USER");
        if (!sudo_user.empty()) {
            util::set_env("SUDO_USER", sudo_user);
        }
    }

    if (!sudo_user.empty()) {
        if (sudo_user == "root") {
            logging::fatal("LimeyV1Installer must not be run as the root user. "
                           "Please rerun as normal user. Use sudo or doas to run as root.");
        }

        logging::debug("LimeyV1Installer was run with root privileges, actual user is " + sudo_user);
        logging::debug("Looking up HOME of " + sudo_user);

        if (passwd* user = getpwnam(sudo_user.c_str()); user != nullptr) {
            logging::debug(std::string("Actual HOME is ") + user->pw_dir);
            util::set_env("HOME", user->pw_dir);
        } else {
            logging::warn("Failed to lookup HOME");
        }
    } else if (getuid() == 0) {
        logging::fatal("LimeyV1Installer was run as root but neither SUDO_USER nor DOAS_USER are set. "
                       "Please rerun me as a normal user, with sudo/doas, or manually set SUDO_USER "
                       "to your username");
    }
}

std::optional<DiscordInstall> parse_discord(const std::string& input, const std::string&) {
    const std::string name = util::base(input);
    std::string path = input;

    // Flatpak installs point at the wrapper directory; the real app lives
    // under current/active/files/<name>.
    const bool needs_flatpak_resolve =
        path.find("/flatpak/") != std::string::npos &&
        path.find("/current/active/files/") == std::string::npos;

    if (needs_flatpak_resolve) {
        const std::string prefix = "com.discordapp.";
        std::string discord_name = util::lower(
            name.size() > prefix.size() ? name.substr(prefix.size()) : name);
        if (discord_name != "discord") {
            // discordcanary -> discord-canary
            discord_name = discord_name.substr(0, 7) + "-" + discord_name.substr(7);
        }
        path = util::join(path, util::join("current/active/files", discord_name));
    }

    const std::string resources = util::join(path, "resources");
    const std::string app = util::join(resources, "app");

    bool is_patched = false;
    bool is_system_electron = false;

    if (util::exists_file(resources)) { // normal install
        is_patched = util::exists_file(util::join(resources, "_app.asar"));
    } else if (util::exists_file(util::join(path, "app.asar"))) {
        // System electron has no resources folder
        is_system_electron = true;
        is_patched = util::exists_file(util::join(path, "_app.asar.unpacked"));
    } else {
        return std::nullopt;
    }

    DiscordInstall install;
    install.path = path;
    install.branch = get_branch(name);
    install.app_path = app;
    install.is_patched = is_patched;
    install.is_flatpak = needs_flatpak_resolve;
    install.is_system_electron = is_system_electron;
    return install;
}

std::optional<DiscordInstall> parse_discord_new(const std::string& path,
                                                const std::string& branch,
                                                bool is_flatpak) {
    std::error_code ec;
    if (!std::filesystem::is_directory(path, ec)) {
        if (ec && ec != std::errc::no_such_file_or_directory) {
            logging::warn("Error during readdir " + path + ": " + ec.message());
        }
        return std::nullopt;
    }

    bool is_patched = false;
    std::string app_path;

    for (const auto& entry : std::filesystem::directory_iterator(path, ec)) {
        const std::string entry_name = entry.path().filename().string();
        if (!entry.is_directory() || !util::starts_with(entry_name, "app-")) {
            continue;
        }
        const std::string resources = util::join(util::join(path, entry_name), "resources");
        if (!util::exists_file(resources)) {
            continue;
        }
        const std::string app = util::join(resources, "app");
        if (app > app_path) {
            app_path = app;
            is_patched = util::exists_file(util::join(resources, "_app.asar"));
        }
    }

    if (app_path.empty()) {
        return std::nullopt;
    }

    DiscordInstall install;
    install.path = path;
    install.branch = branch.empty() ? get_branch(path) : branch;
    install.app_path = app_path;
    install.is_patched = is_patched;
    install.is_flatpak = is_flatpak;
    install.is_system_electron = false;
    return install;
}

std::vector<DiscordInstall> find_discords() {
    std::vector<DiscordInstall> found;

    const std::string home = util::get_env("HOME");
    const std::vector<std::string> dirs = {
        "/usr/share",
        "/usr/lib64",
        "/opt",
        util::join(home, ".local/share"),
        util::join(home, ".dvm"),
        "/var/lib/flatpak/app",
        util::join(home, ".local/share/flatpak/app"),
    };

    for (const auto& dir_path : dirs) {
        std::error_code ec;
        if (!std::filesystem::is_directory(dir_path, ec)) {
            continue;
        }

        for (const auto& child : std::filesystem::directory_iterator(dir_path, ec)) {
            const std::string child_name = child.path().filename().string();
            if (!child.is_directory() ||
                !list_contains(k_linux_discord_names,
                               sizeof(k_linux_discord_names) / sizeof(k_linux_discord_names[0]),
                               child_name)) {
                continue;
            }

            const std::string discord_dir = util::join(dir_path, child_name);
            if (auto install = parse_discord(discord_dir, ""); install.has_value()) {
                logging::debug("Found Discord install at " + discord_dir);
                found.push_back(*install);
            }
        }
    }

    for (const char* name : {"discord", "discordcanary", "discordptb"}) {
        const std::string discord_dir = util::join(util::join(home, ".config"), name);
        if (!util::exists_file(discord_dir)) {
            continue;
        }
        if (auto install = parse_discord_new(discord_dir, get_branch(name), false);
            install.has_value()) {
            logging::debug("Found Discord install at " + discord_dir);
            found.push_back(*install);
        }
    }

    for (const char* name : {"Discord", "DiscordCanary", "DiscordPTB"}) {
        const std::string discord_dir =
            util::join(util::join(util::join(home, ".var/app"), std::string("com.discordapp.") + name),
                       "config/discord");
        if (!util::exists_file(discord_dir)) {
            continue;
        }
        if (auto install = parse_discord_new(discord_dir, get_branch(name), true);
            install.has_value()) {
            logging::debug("Found Discord install at " + discord_dir);
            found.push_back(*install);
        }
    }

    return found;
}

void prepare_patch(const DiscordInstall&) {}

std::string fix_ownership(const std::string& path) {
    if (geteuid() != 0) {
        return "";
    }

    logging::debug("Fixing Ownership of " + path);

    const std::string sudo_user = util::get_env("SUDO_USER");
    if (sudo_user.empty()) {
        return "SUDO_USER was empty. This point should never be reached";
    }

    logging::debug("Looking up User " + sudo_user);
    passwd* user = getpwnam(sudo_user.c_str());
    if (user == nullptr) {
        const std::string err = std::strerror(errno);
        logging::error("Lookup failed: " + err);
        return err;
    }

    logging::debug("Lookup successful, Uid " + std::to_string(user->pw_uid) + " Gid " +
                   std::to_string(user->pw_gid));

    std::error_code ec;
    for (const auto& entry : std::filesystem::recursive_directory_iterator(path, ec)) {
        const std::string child = entry.path().string();
        if (::chown(child.c_str(), user->pw_uid, user->pw_gid) != 0) {
            logging::debug("chown " + child + ": Failed");
            continue;
        }
        logging::debug("chown " + child + ": Success!");
    }
    if (ec) {
        logging::error("Failed to fix ownership: " + ec.message());
        return ec.message();
    }
    return "";
}

bool check_scuffed_install() {
    return false;
}

} // namespace discord

#endif // !_WIN32 && !__APPLE__

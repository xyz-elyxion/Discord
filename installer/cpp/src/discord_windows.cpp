/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

// Windows Discord discovery, ported from installer/find_discord_windows.go.
// Only compiled on Windows; the mingw cross-build in the release workflow is
// the only place this code is exercised.

#include "discord.hpp"

#include "log.hpp"
#include "util.hpp"

#if defined(_WIN32)

#include <windows.h>
#include <tlhelp32.h>

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

namespace discord {
namespace {

struct BranchName {
    const char* branch;
    const char* dir_name;
};

const BranchName k_windows_names[] = {
    {"stable", "Discord"},
    {"ptb", "DiscordPTB"},
    {"canary", "DiscordCanary"},
    {"development", "DiscordDevelopment"},
};

std::string dir_name_for(const std::string& branch) {
    for (const auto& entry : k_windows_names) {
        if (branch == entry.branch) {
            return entry.dir_name;
        }
    }
    return "Discord";
}

std::uint32_t find_process_id_by_name(const std::string& name) {
    const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return 0;
    }

    PROCESSENTRY32 entry{};
    entry.dwSize = sizeof(entry);
    std::uint32_t found = 0;

    if (Process32First(snapshot, &entry)) {
        do {
            const std::wstring wide(entry.szExeFile);
            const std::string exe(wide.begin(), wide.end());
            if (exe == name) {
                found = entry.th32ProcessID;
                break;
            }
        } while (Process32Next(snapshot, &entry));
    }

    CloseHandle(snapshot);
    return found;
}

} // namespace

void init_environment() {}

std::optional<DiscordInstall> parse_discord_new(const std::string&, const std::string&, bool) {
    return std::nullopt;
}

std::optional<DiscordInstall> parse_discord(const std::string& path, const std::string& branch) {
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
    install.is_flatpak = false;
    install.is_system_electron = false;
    return install;
}

std::vector<DiscordInstall> find_discords() {
    std::vector<DiscordInstall> found;

    const std::string app_data = util::get_env("LOCALAPPDATA");
    if (app_data.empty()) {
        logging::error("%LOCALAPPDATA% is empty???????");
        return found;
    }

    for (const auto& entry : k_windows_names) {
        const std::string path = util::join(app_data, entry.dir_name);
        if (auto install = parse_discord(path, entry.branch); install.has_value()) {
            logging::debug("Found Discord install at " + path);
            found.push_back(*install);
        }
    }
    return found;
}

void prepare_patch(const DiscordInstall& install) {
    const std::string name = dir_name_for(install.branch);
    logging::debug("Trying to kill " + name);

    const std::uint32_t pid = find_process_id_by_name(name + ".exe");
    if (pid == 0) {
        logging::debug("Didn't find process matching name");
        return;
    }

    const HANDLE process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
    if (process == nullptr) {
        logging::warn("Failed to find process with pid " + std::to_string(pid));
        return;
    }

    if (!TerminateProcess(process, 1)) {
        logging::warn("Failed to kill " + name + ": error " + std::to_string(GetLastError()));
    } else {
        logging::debug("Waiting for " + name + " to exit");
        WaitForSingleObject(process, 10000);
    }
    CloseHandle(process);
}

std::string fix_ownership(const std::string&) {
    return "";
}

bool check_scuffed_install() {
    const std::string username = util::get_env("USERNAME");
    const std::string program_data = util::get_env("PROGRAMDATA");
    for (const auto& entry : k_windows_names) {
        const std::string scuffed = util::join(util::join(program_data, username), entry.dir_name);
        if (util::exists_file(scuffed)) {
            handle_scuffed_install();
            return true;
        }
    }
    return false;
}

} // namespace discord

#endif // _WIN32

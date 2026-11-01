/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

// Port of installer/cli.go (+ the tiny platform shims cli_windows.go and
// cli_other.go): argument parsing, the interactive menu and the Discord
// picker, driving the same patch/unpatch/download flow the Go CLI did.

#include "buildinfo.hpp"
#include "discord.hpp"
#include "downloader.hpp"
#include "log.hpp"
#include "paths.hpp"
#include "patcher.hpp"
#include "self_updater.hpp"
#include "util.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace {

const char* const k_site = "https://limey-discord.onrender.com";
const char* const k_help_url = "https://limey-discord.onrender.com/404.html";

struct Options {
    bool debug = false;
    bool help = false;
    bool version = false;
    bool update_self = false;
    bool install = false;
    bool repair = false;
    bool uninstall = false;
    std::string location;
    std::string branch;
    std::string channel = "stable";
};

// Set when the user picked a menu entry, so the Windows build can hold the
// console open when the exe was double-clicked instead of run from a shell.
bool g_interactive = false;

std::string join_pipe(const std::vector<std::string>& values) {
    std::string out;
    for (const auto& value : values) {
        if (!out.empty()) {
            out.push_back('|');
        }
        out += value;
    }
    return out;
}

void usage(const char* program) {
    std::printf("Usage of %s:\n", program);
    std::printf("  -branch string\n\tThe branch of Discord to modify [auto|stable|ptb|canary|development]\n");
    std::printf("  -channel string\n\tThe Limey V1 release channel to install [%s]\n",
                join_pipe(downloader::release_channels()).c_str());
    std::printf("  -debug\n\tEnable debug info\n");
    std::printf("  -help\n\tView usage instructions\n");
    std::printf("  -install\n\tInstall Limey V1\n");
    std::printf("  -location string\n\tThe location of the Discord install to modify\n");
    std::printf("  -repair\n\tRepair Limey V1\n");
    std::printf("  -uninstall\n\tUninstall Limey V1\n");
    std::printf("  -update-self\n\tUpdate me to the latest version\n");
    std::printf("  -version\n\tView the program version\n");
    std::fflush(stdout);
}

bool is_valid_branch(const std::string& branch) {
    // "development" is Discord's Development branch — the same id the Limey
    // V1 channel registry uses for the host (minus the "discord-" prefix).
    for (const char* known : {"", "stable", "ptb", "canary", "auto", "development"}) {
        if (branch == known) {
            return true;
        }
    }
    return false;
}

bool parse_bool_value(const std::string& value, bool* out) {
    const std::string lowered = util::lower(value);
    if (lowered == "1" || lowered == "t" || lowered == "true") {
        *out = true;
        return true;
    }
    if (lowered == "0" || lowered == "f" || lowered == "false") {
        *out = false;
        return true;
    }
    return false;
}

Options parse_args(int argc, char** argv) {
    Options options;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg.empty() || arg[0] != '-') {
            std::printf("unexpected argument %s\n", arg.c_str());
            usage(argv[0]);
            std::exit(2);
        }

        std::string name = arg;
        while (!name.empty() && name[0] == '-') {
            name.erase(name.begin());
        }

        std::string value;
        bool has_value = false;
        if (const auto equals = name.find('='); equals != std::string::npos) {
            value = name.substr(equals + 1);
            name = name.substr(0, equals);
            has_value = true;
        }

        auto take_bool = [&](bool* target) {
            *target = true;
            if (has_value && !parse_bool_value(value, target)) {
                std::printf("invalid boolean value %s for -%s\n", value.c_str(), name.c_str());
                usage(argv[0]);
                std::exit(2);
            }
        };
        auto take_string = [&](std::string* target) {
            if (has_value) {
                *target = value;
                return;
            }
            if (i + 1 >= argc) {
                std::printf("flag needs an argument: -%s\n", name.c_str());
                usage(argv[0]);
                std::exit(2);
            }
            *target = argv[++i];
        };

        if (name == "debug") {
            take_bool(&options.debug);
        } else if (name == "help" || name == "h") {
            take_bool(&options.help);
        } else if (name == "version") {
            take_bool(&options.version);
        } else if (name == "update-self") {
            take_bool(&options.update_self);
        } else if (name == "install") {
            take_bool(&options.install);
        } else if (name == "repair") {
            take_bool(&options.repair);
        } else if (name == "uninstall") {
            take_bool(&options.uninstall);
        } else if (name == "location") {
            take_string(&options.location);
        } else if (name == "branch") {
            take_string(&options.branch);
        } else if (name == "channel") {
            take_string(&options.channel);
        } else {
            std::printf("flag provided but not defined: -%s\n", name.c_str());
            usage(argv[0]);
            std::exit(2);
        }
    }

    return options;
}

bool is_double_click_run() {
#ifdef _WIN32
    // Two or more attached consoles means we were started from a shell.
    const HMODULE kernel32 = GetModuleHandleA("kernel32.dll");
    if (kernel32 != nullptr) {
        using get_console_process_list = DWORD(WINAPI*)(DWORD*, DWORD);
        const auto proc = reinterpret_cast<get_console_process_list>(
            reinterpret_cast<void*>(GetProcAddress(kernel32, "GetConsoleProcessList")));
        if (proc != nullptr) {
            DWORD pids[2] = {0, 0};
            return proc(pids, 2) <= 1;
        }
    }
    return true;
#else
    return false;
#endif
}

[[noreturn]] void exit_with(int status) {
    if (is_double_click_run() && g_interactive) {
        std::printf("Press Enter to exit");
        std::fflush(stdout);
        std::getchar();
    }
    std::exit(status);
}

[[noreturn]] void exit_success() {
    std::printf("\x1b[92m✔ Success!\x1b[0m\n");
    std::fflush(stdout);
    exit_with(0);
}

[[noreturn]] void exit_failure() {
    std::printf("\x1b[91m❌ Failed! If this issue persists, see %s\x1b[0m\n", k_help_url);
    std::fflush(stdout);
    exit_with(1);
}

[[noreturn]] void die(const std::string& message) {
    logging::error(message);
    exit_failure();
}

// Numbered selection (the Go CLI used promptui's arrow-key list; a port with
// no TUI dependency picks by number, which also works when input is piped).
std::optional<std::string> prompt_choice(const std::string& label,
                                         const std::vector<std::string>& items) {
    std::printf("%s\n", label.c_str());
    for (std::size_t i = 0; i < items.size(); ++i) {
        std::printf("  %zu) %s\n", i + 1, items[i].c_str());
    }

    while (true) {
        std::printf("> ");
        std::fflush(stdout);

        std::string line;
        if (!std::getline(std::cin, line)) {
            // EOF (Ctrl+D) behaves like promptui's Ctrl+C: leave quietly.
            exit_with(0);
        }
        const std::string trimmed = util::trim(line);
        if (trimmed.empty()) {
            continue;
        }

        char* end = nullptr;
        const long choice = std::strtol(trimmed.c_str(), &end, 10);
        if (end != nullptr && *end == '\0' && choice >= 1 &&
            choice <= static_cast<long>(items.size())) {
            return items[static_cast<std::size_t>(choice - 1)];
        }

        // Accept the label itself too, so a script can pipe it in.
        for (const auto& item : items) {
            if (item == trimmed) {
                return item;
            }
        }
        std::printf("Please enter a number between 1 and %zu.\n", items.size());
    }
}

std::optional<std::string> prompt_text(const std::string& label) {
    std::printf("%s\n> ", label.c_str());
    std::fflush(stdout);
    std::string line;
    if (!std::getline(std::cin, line)) {
        exit_with(0);
    }
    return util::trim(line);
}

DiscordInstall prompt_discord(const std::vector<DiscordInstall>& discords,
                              const std::string& action,
                              const std::string& dir,
                              const std::string& branch) {
    if (branch == "auto") {
        for (const char* wanted : {"stable", "canary", "ptb", "development"}) {
            for (const auto& install : discords) {
                if (install.branch == wanted) {
                    return install;
                }
            }
        }
        die("No Discord install found. Before proceeding, make sure Discord is installed. "
            "snap is not supported!");
    }

    if (!branch.empty()) {
        for (const auto& install : discords) {
            if (install.branch == branch) {
                return install;
            }
        }
        die("Discord " + branch + " not found");
    }

    if (!dir.empty()) {
        if (auto install = discord::parse_discord(dir, branch); install.has_value()) {
            return *install;
        }
        if (auto install = discord::parse_discord_new(
                dir, branch, dir.find("com.discordapp") != std::string::npos);
            install.has_value()) {
            return *install;
        }
        die(dir + " is not a valid Discord install. Hint: snap is not supported");
    }

    std::vector<std::string> items;
    items.reserve(discords.size() + 1);
    for (const auto& install : discords) {
        items.push_back(util::title(install.branch) + " - " + install.path +
                        (install.is_patched ? " [Limey V1 Installed]" : ""));
    }
    const std::string custom_label = "Custom Location";
    items.push_back(custom_label);

    const auto choice =
        prompt_choice("Select Discord install to " + action + " (Press Enter to confirm)", items);
    if (!choice.has_value()) {
        die("No selection made");
    }

    if (*choice != custom_label) {
        const auto index = static_cast<std::size_t>(std::distance(
            items.begin(), std::find(items.begin(), items.end(), *choice)));
        return discords[index];
    }

    while (true) {
        const auto custom = prompt_text("Custom Discord Location");
        if (!custom.has_value() || custom->empty()) {
            continue;
        }
        if (auto install = discord::parse_discord(*custom, ""); install.has_value()) {
            return *install;
        }
        if (auto install = discord::parse_discord_new(
                *custom, "", custom->find("com.discordapp") != std::string::npos);
            install.has_value()) {
            return *install;
        }
        logging::error("Invalid Discord install!");
    }
}

} // namespace

int main(int argc, char** argv) {
    Options options = parse_args(argc, argv);

    if (options.help) {
        usage(argv[0]);
        return 0;
    }

    if (options.version) {
        std::printf("Limey V1 Installer Cli %s\n", buildinfo::InstallerVersion);
        std::printf("Copyright (C) 2026 Limey V1 contributors\n");
        std::printf("License GPLv3+: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.\n");
        return 0;
    }

    logging::set_level(options.debug ? logging::Level::Debug : logging::Level::Info);

    discord::init_environment();
    paths::init();

    if (!paths::FilesDirErr.empty()) {
        die("Failed to create " + paths::FilesDir + ": " + paths::FilesDirErr);
    }

    downloader::init();

    if (options.update_self) {
        if (const std::string err = self_updater::update_self(); !err.empty()) {
            die("Failed to update self: " + err);
        }
        exit_success();
    }

    if (!downloader::is_valid_channel(options.channel)) {
        die("The 'channel' flag must be one of: [" + join_pipe(downloader::release_channels()) +
            "] (preview is a UI label — use --channel rc or --channel beta)");
    }
    downloader::ReleaseChannel = options.channel;

    if (!is_valid_branch(options.branch)) {
        die("The 'branch' flag must be one of the following: [auto|stable|ptb|canary|development]");
    }

    if (!options.location.empty() && !options.branch.empty()) {
        die("The 'location' and 'branch' flags are mutually exclusive.");
    }

    const std::vector<DiscordInstall> discords = discord::find_discords();

    bool install = options.install;
    bool repair = options.repair;
    bool uninstall = options.uninstall;

    if (!install && !repair && !uninstall) {
        g_interactive = true;

        const std::vector<std::string> choices = {
            "Install Limey V1",
            "Repair Limey V1",
            "Uninstall Limey V1",
            "View Help Menu",
            "Update Limey V1 Installer",
            "Quit",
        };
        const auto choice = prompt_choice("What would you like to do? (Press Enter to confirm)", choices);
        if (!choice.has_value()) {
            exit_with(0);
        }

        if (*choice == "View Help Menu") {
            usage(argv[0]);
            return 0;
        }
        if (*choice == "Quit") {
            return 0;
        }
        if (*choice == "Update Limey V1 Installer") {
            if (const std::string err = self_updater::update_self(); !err.empty()) {
                die("Failed to update self: " + err);
            }
            exit_success();
        }

        install = *choice == "Install Limey V1";
        repair = *choice == "Repair Limey V1";
        uninstall = *choice == "Uninstall Limey V1";
    }

    // Build-check gate: both install and repair need the build data, so abort
    // here instead of failing halfway through patching.
    if ((install || repair) && !downloader::wait_for_build_check()) {
        die(std::string("Not ") + (install ? "installing" : "updating") +
            " as fetching build data failed. If this issue persists, see " + k_help_url);
    }

    std::string error;

    if (install) {
        DiscordInstall install_target = prompt_discord(discords, "patch", options.location, options.branch);
        error = patcher::patch(install_target);
    } else if (uninstall) {
        DiscordInstall uninstall_target =
            prompt_discord(discords, "unpatch", options.location, options.branch);
        error = patcher::unpatch(uninstall_target);
    } else if (repair) {
        logging::info("Downloading latest Limey V1 files...");
        error = downloader::fetch_latest_builds();
        logging::info("Done!");
        if (error.empty()) {
            DiscordInstall repair_target =
                prompt_discord(discords, "repair", options.location, options.branch);
            error = patcher::patch(repair_target);
        }
    }

    if (!error.empty()) {
        logging::error(error);
        exit_failure();
    }

    exit_success();
}

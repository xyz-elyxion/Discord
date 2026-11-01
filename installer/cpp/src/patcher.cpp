/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "patcher.hpp"

#include "asar.hpp"
#include "discord.hpp"
#include "downloader.hpp"
#include "log.hpp"
#include "paths.hpp"
#include "util.hpp"

#include <cstdlib>
#include <string>
#include <vector>

namespace patcher {
namespace {

// Renames recorded so a half-finished patch can be rolled back. Mirrors the
// `renamesDone` slice the Go code undid in its deferred function.
struct RenameEntry {
    std::string from;
    std::string to;
};

void undo_renames(const std::vector<RenameEntry>& renames, const char* what) {
    logging::error(std::string("Failed to ") + what + ". Undoing partial " + what);
    for (const auto& rename : renames) {
        if (const std::string err = util::rename(rename.to, rename.from); !err.empty()) {
            logging::error(std::string("Failed to undo partial ") + what +
                           ". This install is probably bricked. " + err);
        } else {
            logging::info("Successfully undid all changes");
        }
    }
}

std::string run_command(const std::string& command) {
    logging::debug("Running " + command);
    const int status = std::system(command.c_str());
    if (status != 0) {
        return "command exited with status " + std::to_string(status);
    }
    return "";
}

std::string quote(const std::string& value) {
    return "\"" + value + "\"";
}

// `flatpak override <app> --filesystem=<FilesDir>` so the sandboxed app can
// read the patcher, run as the real user when the installer was started with
// sudo.
std::string grant_flatpak_access(const DiscordInstall& install) {
    std::string app_name;
    for (const auto& element : util::split(install.path, '/')) {
        if (util::starts_with(element, "com.discordapp")) {
            app_name = element;
            break;
        }
    }

    logging::debug("This is a flatpak. Trying to grant the Flatpak access to " + paths::FilesDir + "...");

    const bool is_system_flatpak = util::starts_with(install.path, "/var");
    std::vector<std::string> args;
    if (!is_system_flatpak) {
        args.emplace_back("--user");
    }
    args.emplace_back("override");
    args.emplace_back(app_name);
    args.emplace_back("--filesystem=" + paths::FilesDir);

    std::string flatpak_command = "flatpak";
    for (const auto& arg : args) {
        flatpak_command += " " + quote(arg);
    }

    std::string err;
    if (!is_system_flatpak && util::current_uid() == 0) {
        const std::string actual_user = util::get_env("SUDO_USER");
        logging::debug("This is a user install but we are root. Using su to run as " + actual_user);
        err = run_command("su - " + quote(actual_user) + " -c " + quote("sh -c " + quote(flatpak_command)));
    } else {
        err = run_command(flatpak_command);
    }

    if (!err.empty()) {
        return "Failed to grant Discord Flatpak access to " + paths::FilesDir + ": " + err;
    }
    return "";
}

} // namespace

std::string patch_app_asar(const std::string& dir, bool is_system_electron) {
    const std::string app_asar = util::join(dir, "app.asar");
    const std::string underscore_asar = util::join(dir, "_app.asar");

    std::vector<RenameEntry> renames;

    logging::debug("Renaming " + app_asar + " to " + underscore_asar);
    if (const std::string err = util::rename(app_asar, underscore_asar); !err.empty()) {
        logging::error(err);
        return err;
    }
    renames.push_back({app_asar, underscore_asar});

    if (is_system_electron) {
        const std::string from = app_asar + ".unpacked";
        const std::string to = underscore_asar + ".unpacked";
        logging::debug("Renaming " + from + " to " + to);
        if (const std::string err = util::rename(from, to); !err.empty()) {
            undo_renames(renames, "patch");
            return err;
        }
        renames.push_back({from, to});
    }

    logging::debug("Writing custom app.asar to " + app_asar);
    if (const std::string err = asar::write_app_asar(app_asar, paths::Patcher); !err.empty()) {
        undo_renames(renames, "patch");
        return err;
    }

    return "";
}

std::string unpatch_app_asar(const std::string& dir, bool is_system_electron) {
    const std::string app_asar = util::join(dir, "app.asar");
    const std::string app_asar_tmp = util::join(dir, "app.asar.tmp");
    const std::string underscore_asar = util::join(dir, "_app.asar");

    std::vector<RenameEntry> renames;

    logging::debug("Deleting " + app_asar);
    std::string error;
    if (const std::string err = util::rename(app_asar, app_asar_tmp); !err.empty()) {
        logging::error(err);
        error = err;
    } else {
        renames.push_back({app_asar, app_asar_tmp});
    }

    logging::debug("Renaming " + underscore_asar + " to " + app_asar);
    if (const std::string err = util::rename(underscore_asar, app_asar); !err.empty()) {
        logging::error(err);
        error = err;
    } else {
        renames.push_back({underscore_asar, app_asar});
    }

    if (is_system_electron) {
        logging::debug("Renaming " + underscore_asar + ".unpacked to " + app_asar + ".unpacked");
        if (const std::string err = util::rename(underscore_asar + ".unpacked", app_asar + ".unpacked");
            !err.empty()) {
            logging::error(err);
            error = err;
        }
    }

    if (!error.empty()) {
        undo_renames(renames, "unpatch");
        return error;
    }

    // The patched app.asar backup is no longer needed once the original is
    // back in place.
    if (const std::string err = util::remove_all(app_asar_tmp); !err.empty()) {
        logging::warn("Failed to delete temporary app.asar (patch folder) backup. "
                      "This is whatever but you might want to delete it manually. " + err);
    }
    return "";
}

std::string patch(DiscordInstall& install) {
    logging::info("Patching " + install.path + "...");

    if (downloader::LatestHash != downloader::InstalledHash) {
        // Fetch failures were already logged by the downloader; surface them
        // so the CLI prints FAILED instead of success.
        if (const std::string err = downloader::fetch_latest_builds(); !err.empty()) {
            return err;
        }
    }

    // Go fixed ownership inside FetchLatestBuilds; doing it here keeps the
    // downloader free of platform code and happens on every patch, including
    // the dev-install path that skips downloading.
    if (const std::string err = discord::fix_ownership(paths::FilesDir); !err.empty()) {
        logging::warn("Failed to fix ownership of " + paths::FilesDir + ": " + err);
    }

    discord::prepare_patch(install);

    if (install.is_patched) {
        logging::info(install.path + " is already patched. Unpatching first...");
        if (const std::string err = unpatch(install); !err.empty()) {
            return "patch: Failed to unpatch already patched install '" + install.path + "':\n" + err;
        }
    }

    const std::string target = install.is_system_electron ? install.path
                                                         : util::join(install.app_path, "..");
    if (const std::string err = patch_app_asar(target, install.is_system_electron); !err.empty()) {
        return err;
    }

    logging::info("Successfully patched " + install.path);
    install.is_patched = true;

    if (const std::string err = downloader::write_channel_marker(); !err.empty()) {
        logging::warn("Failed to write channel marker " + err);
    }

    if (install.is_flatpak) {
        if (const std::string err = grant_flatpak_access(install); !err.empty()) {
            return err;
        }
    }

    return "";
}

std::string unpatch(DiscordInstall& install) {
    logging::info("Unpatching " + install.path + "...");

    discord::prepare_patch(install);

    const std::string target = install.is_system_electron ? install.path
                                                         : util::join(install.app_path, "..");
    if (const std::string err = unpatch_app_asar(target, install.is_system_electron); !err.empty()) {
        return err;
    }

    logging::info("Successfully unpatched " + install.path);
    install.is_patched = false;
    return "";
}

} // namespace patcher

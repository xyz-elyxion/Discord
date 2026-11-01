/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "downloader.hpp"

#include "http.hpp"
#include "log.hpp"
#include "paths.hpp"
#include "util.hpp"

#include <condition_variable>
#include <mutex>
#include <thread>

namespace downloader {

std::string InstalledHash = "None";
std::string LatestHash = "Unknown";
bool IsDevInstall = false;
std::string ReleaseChannel = "stable";

namespace {

// The Go installer signalled this through a 1-buffered channel; a latch is
// the same "wait for the first hash check, get its result" barrier without
// the deadlock the channel needed draining for.
struct BuildDone {
    std::mutex mutex;
    std::condition_variable cv;
    bool ready = false;
    bool value = false;

    void set(bool ok) {
        {
            std::lock_guard<std::mutex> lock(mutex);
            ready = true;
            value = ok;
        }
        cv.notify_all();
    }

    bool wait() {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock, [this] { return ready; });
        return value;
    }
};

BuildDone g_build_done;

// First line of the tiny renderer.css the backend stamps with the hash.
std::optional<std::string> fetch_remote_hash() {
    const http::Response response = http::get(file_url("renderer.css"));
    if (!response.ok()) {
        logging::warn("Failed to check for updates: " + response.error);
        return std::nullopt;
    }
    if (response.status >= 300) {
        logging::warn("Failed to check for updates: HTTP " + std::to_string(response.status));
        return std::nullopt;
    }

    const auto line = util::first_line_of(response.body, 1024);
    if (!line.has_value()) {
        return std::nullopt;
    }
    return parse_hash_line(*line);
}

} // namespace

const std::vector<std::string>& build_files() {
    static const std::vector<std::string> files = {
        "patcher.js",
        "preload.js",
        "renderer.js",
        "renderer.css",
    };
    return files;
}

const std::vector<std::string>& release_channels() {
    static const std::vector<std::string> channels = {
        "stable",     "lts",        "rc",         "beta",     "canary",
        "alpha",      "nightly",    "edge",       "debug",    "custom",
        "snapshot",   "experimental", "early",    "insider",  "preview-ch",
        "dev-preview", "internal",  "community",
    };
    return channels;
}

std::string base_url() {
    return util::get_env_or("LIMEY_INSTALLER_BASE_URL", "https://limey-discord.onrender.com");
}

bool is_valid_channel(const std::string& channel) {
    for (const auto& known : release_channels()) {
        if (known == channel) {
            return true;
        }
    }
    return false;
}

std::string channel_label(const std::string& channel) {
    if (channel == "stable") return "Stable — recommended for everyone";
    if (channel == "lts") return "Stable LTS — frozen stable, fixes only";
    if (channel == "rc") return "Release Candidate — next version, pre-stable";
    if (channel == "beta") return "Beta — early adopters";
    if (channel == "canary") return "Canary — freshest pre-release";
    if (channel == "alpha") return "Alpha — earliest, for plugin devs";
    if (channel == "nightly") return "Nightly — scheduled main-branch snapshot";
    if (channel == "edge") return "Edge — built per push, freshest";
    if (channel == "debug") return "Debug — verbose diagnostic build";
    if (channel == "custom") return "Custom — fork's own build stream";
    if (channel == "snapshot") return "Snapshot — point-in-time dev build";
    if (channel == "experimental") return "Experimental — opt-in features, unstable";
    if (channel == "early") return "Early Access — next batch a bit sooner";
    if (channel == "insider") return "Insider — beta artifacts with release notes";
    if (channel == "preview-ch") return "Preview (Beta) — same stream, friendlier name";
    if (channel == "dev-preview") return "Developer Preview — API-frozen per milestone";
    if (channel == "internal") return "Internal — core-collaborator ring";
    if (channel == "community") return "Community — top-voted experiments";
    return channel;
}

std::string parse_hash_line(const std::string& line) {
    const std::string prefix = "// Limey ";
    const std::string css_prefix = "/* Limey ";

    if (util::starts_with(line, prefix)) {
        std::string rest = line.substr(prefix.size());
        if (util::ends_with(rest, "*/")) {
            rest.resize(rest.size() - 2);
        }
        return util::trim(rest);
    }
    if (util::starts_with(line, css_prefix)) {
        std::string rest = line.substr(css_prefix.size());
        if (util::ends_with(rest, "*/")) {
            rest.resize(rest.size() - 2);
        }
        return util::trim(rest);
    }
    return "";
}

std::string file_url(const std::string& name) {
    // The stable channel serves the current build files; snapshot channels are
    // served from /v1/install/files/<channel>/<name>.
    if (ReleaseChannel != "stable") {
        return base_url() + "/v1/install/files/" + ReleaseChannel + "/" + name;
    }
    return base_url() + "/v1/install/files/" + name;
}

void set_build_done(bool ok) {
    g_build_done.set(ok);
}

bool wait_for_build_check() {
    return g_build_done.wait();
}

bool check_latest_hash() {
    const auto hash = fetch_remote_hash();
    if (hash.has_value() && !hash->empty()) {
        LatestHash = *hash;
        logging::debug("Latest hash is " + LatestHash + " Local Install is " +
                       (LatestHash == InstalledHash ? "up to date!" : "outdated!"));
    } else if (hash.has_value()) {
        // Reachable but unstamped: treat as a build we cannot compare.
        logging::debug("Remote build carries no hash");
    }

    const bool ok = hash.has_value();
    set_build_done(ok);
    return ok;
}

void init() {
    IsDevInstall = !util::get_env("LIMEY_DEV_INSTALL").empty();

    if (IsDevInstall) {
        LatestHash = "dev";
        set_build_done(true);
        return;
    }

    // Installed hash: first line of the patcher we left behind. The Go
    // installer read this before the data directory was resolved, so it never
    // actually found an existing install; resolve paths first instead.
    if (const auto line = util::read_first_line(paths::Patcher, 1024); line.has_value()) {
        logging::debug("Found existing Limey V1 Install. Checking for hash...");
        if (const std::string hash = parse_hash_line(*line); !hash.empty()) {
            InstalledHash = hash;
            logging::debug("Existing hash is " + InstalledHash);
        } else {
            logging::debug("Didn't find hash");
        }
    }

    std::thread([] {
        if (!check_latest_hash()) {
            set_build_done(false);
        }
    }).detach();
}

std::string fetch_latest_builds() {
    if (IsDevInstall) {
        set_build_done(true);
        return "";
    }

    logging::debug("Installing latest builds...");

    // An empty package.json stops node from walking up to a parent
    // package.json that might declare "type": "module".
    const std::string package_json = util::join(paths::FilesDir, "package.json");
    if (!util::write_file(package_json, "{}")) {
        logging::warn("Failed to create " + package_json);
    }

    std::mutex first_error_mutex;
    std::string first_error;
    unsigned long downloaded = 0;
    std::vector<std::thread> workers;

    for (const auto& name : build_files()) {
        workers.emplace_back([&, name] {
            logging::debug("Downloading file " + name);
            const http::Response response = http::get(file_url(name));

            std::string error;
            if (!response.ok()) {
                error = "failed to download " + name + ": " + response.error;
            } else if (response.status >= 300) {
                error = "failed to download " + name + ": HTTP " + std::to_string(response.status);
            } else if (response.body.empty()) {
                error = "downloaded empty file " + name;
            } else {
                const std::string out_file = util::join(paths::FilesDir, name);
                if (!util::write_file(out_file, response.body)) {
                    error = "failed to create " + out_file;
                } else {
                    std::lock_guard<std::mutex> lock(first_error_mutex);
                    ++downloaded;
                }
            }

            if (!error.empty()) {
                logging::error(error);
                std::lock_guard<std::mutex> lock(first_error_mutex);
                if (first_error.empty()) {
                    first_error = error;
                }
            }
        });
    }

    for (auto& worker : workers) {
        worker.join();
    }

    if (!first_error.empty()) {
        set_build_done(false);
        return first_error;
    }
    if (downloaded < build_files().size()) {
        set_build_done(false);
        return "Couldn't find all required files";
    }

    logging::debug("Done!");
    InstalledHash = LatestHash;
    set_build_done(true);
    return "";
}

std::string write_channel_marker() {
    const std::string marker = util::join(paths::FilesDir, "channel.txt");
    if (!util::write_file(marker, ReleaseChannel + "\n")) {
        logging::warn("Failed to write channel marker " + marker);
        return marker;
    }
    return "";
}

std::string read_installed_channel() {
    const auto content = util::read_file_checked(util::join(paths::FilesDir, "channel.txt"));
    if (!content.has_value()) {
        return "stable";
    }
    const std::string channel = util::trim(*content);
    if (!is_valid_channel(channel)) {
        return "stable";
    }
    return channel;
}

} // namespace downloader

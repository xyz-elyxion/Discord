/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>
#include <vector>

// Build fetching, ported from installer/downloader.go. Every function here is
// network-facing: the CLI reaches the Limey backend through these.
namespace downloader {

extern std::string InstalledHash; // "None" until an install is detected
extern std::string LatestHash;    // "Unknown" until the hash check answers
extern bool IsDevInstall;         // LIMEY_DEV_INSTALL skips all downloads
extern std::string ReleaseChannel; // "stable" unless --channel says otherwise

// The files fetched into <FilesDir>; the backend serves them at
// <BaseUrl>/v1/install/files/<name>.
const std::vector<std::string>& build_files();

// Installable channels, the implemented subset of the /v1/channels registry.
const std::vector<std::string>& release_channels();

// LIMEY_INSTALLER_BASE_URL override for local development, else the live site.
std::string base_url();

bool is_valid_channel(const std::string& channel);
std::string channel_label(const std::string& channel);

// Extracts "<hash>" from the "// Limey <hash>" / "/* Limey <hash> */" stamp
// the backend writes as the first line of every served file.
std::string parse_hash_line(const std::string& line);

std::string file_url(const std::string& name);

// Reads the installed hash and starts the asynchronous latest-hash check.
// Call after paths::init() so the install can actually be found.
void init();

void set_build_done(bool ok);
// Blocks until the hash check finished and returns its result (the CLI used
// this channel to abort early instead of failing halfway through patching).
bool wait_for_build_check();

// Synchronous re-check for the currently selected channel.
bool check_latest_hash();

// Downloads every build file. Returns "" on success, the first error
// otherwise. Sets InstalledHash to LatestHash when it succeeds.
std::string fetch_latest_builds();

// Persists the channel next to the build files so an LTS install does not
// wander back to stable when the in-app updater runs.
std::string write_channel_marker();
std::string read_installed_channel();

} // namespace downloader

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>

// Installer data directories, ported from the init() in patcher.go. Kept in
// their own module so the downloader and the tests can use them without
// pulling in the patching code.
namespace paths {

extern std::string BaseDir;
extern std::string FilesDir;
extern std::string Patcher;
// Non-empty when the data directory could not be created; the CLI reports it
// and refuses to patch, the GUI used to show a full-page error card.
extern std::string FilesDirErr;

// Resolves LIMEY_USER_DATA_DIR / DISCORD_USER_DATA_DIR / the per-OS user
// config dir, creates <BaseDir>/dist and sets Patcher. Call after the
// environment fix-ups in discord::init_environment().
void init();

} // namespace paths

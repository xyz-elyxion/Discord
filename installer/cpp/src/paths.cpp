/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "paths.hpp"

#include "log.hpp"
#include "util.hpp"

namespace paths {

std::string BaseDir;
std::string FilesDir;
std::string Patcher;
std::string FilesDirErr;

void init() {
    const std::string user_data_dir = util::get_env("LIMEY_USER_DATA_DIR");
    const std::string discord_user_data_dir = util::get_env("DISCORD_USER_DATA_DIR");

    if (!user_data_dir.empty()) {
        logging::debug("Using LIMEY_USER_DATA_DIR");
        BaseDir = user_data_dir;
    } else if (!discord_user_data_dir.empty()) {
        logging::debug("Using DISCORD_USER_DATA_DIR/../LimeyData");
        BaseDir = util::join(discord_user_data_dir, "../LimeyData");
    } else {
        logging::debug("Using UserConfig");
        BaseDir = util::user_config_dir("LimeyV1");
    }

    FilesDir = util::join(BaseDir, "dist");

    if (!util::exists_file(FilesDir)) {
        const std::string err = util::make_dirs(FilesDir);
        if (!err.empty()) {
            FilesDirErr = err;
            logging::error("Failed to create " + FilesDir + ": " + err);
        }
    }

    Patcher = util::join(FilesDir, "patcher.js");
}

} // namespace paths

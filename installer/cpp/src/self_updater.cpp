/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "self_updater.hpp"

#include "downloader.hpp"

namespace self_updater {

bool IsSelfOutdated = false;

std::string download_link() {
    return downloader::base_url() + "/download";
}

bool can_update_self() {
    return false;
}

std::string update_self() {
    return "Self-update is disabled. Please re-download the installer from " + download_link();
}

void delete_old_executable() {}

} // namespace self_updater

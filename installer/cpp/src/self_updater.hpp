/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>

// Port of installer/self_updater.go: self-updating is intentionally disabled,
// users re-download the installer from the website. The functions stay so the
// CLI keeps its --update-self switch and its wording.
namespace self_updater {

extern bool IsSelfOutdated;

std::string download_link();
bool can_update_self();
// Non-empty result = the update failed, with the message to show the user.
std::string update_self();
void delete_old_executable();

} // namespace self_updater

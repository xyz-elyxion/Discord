/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

// Logic shared by every platform: branch detection and the CLI's plain-text
// version of the broken-install warning.

#include "discord.hpp"

#include "util.hpp"

#include <cstdio>

namespace discord {
namespace {

const char* k_branches[] = {"canary", "development", "ptb"};

} // namespace

std::string get_branch(const std::string& name) {
    const std::string lowered = util::lower(name);
    for (const char* branch : k_branches) {
        if (util::ends_with(lowered, branch)) {
            return branch;
        }
    }
    return "stable";
}

void handle_scuffed_install() {
    std::printf("Hold On!\n");
    std::printf("You have a broken Discord Install.\n");
    std::printf("Please reinstall Discord before proceeding!\n");
    std::printf("Otherwise, Limey V1 will likely not work.\n");
    std::fflush(stdout);
}

} // namespace discord

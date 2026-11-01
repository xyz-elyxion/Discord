/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>

namespace logging {

enum class Level { Debug = 0, Info, Warn, Error, Fatal };

// Debug output is on when the process was started with -debug/--debug, the
// same switch the Go installer used (its GUI always forced it on).
void set_level(Level level);
Level level();

void log(Level level, const std::string& message);

void debug(const std::string& message);
void info(const std::string& message);
void warn(const std::string& message);
void error(const std::string& message);

// Prints at Fatal level and exits with status 1.
[[noreturn]] void fatal(const std::string& message);

} // namespace logging

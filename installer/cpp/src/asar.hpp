/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>

namespace asar {

// Writes the tiny "app.asar" that makes Electron require() our patcher.
// Ported from installer/app_asar.go, which in turn came from asar-cr.
// Returns "" on success, the error otherwise.
std::string write_app_asar(const std::string& out_file, const std::string& patcher_path);

// The package.json that goes inside the archive (no "type": "module", so
// Discord's own CommonJS entry keeps working).
extern const char* PackageJson;

// JSON string literal, escaping exactly what Go's encoding/json escaped for a
// path (backslashes on Windows, quotes, control characters, HTML-safe <>&).
std::string json_string(const std::string& value);

} // namespace asar

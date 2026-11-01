/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <optional>
#include <string>
#include <vector>

namespace util {

std::string lower(std::string value);
bool starts_with(const std::string& value, const std::string& prefix);
bool ends_with(const std::string& value, const std::string& suffix);
std::string trim(const std::string& value);
std::vector<std::string> split(const std::string& value, char separator);
std::string repeat(const std::string& value, std::size_t times);

// Path helpers mirroring filepath.Join/Dir/Base (a trailing separator is
// dropped, ".." segments are kept verbatim like Go does).
std::string join(const std::string& a, const std::string& b);
std::string join(const std::vector<std::string>& parts);
std::string dir(const std::string& path);
std::string base(const std::string& path);

bool exists_file(const std::string& path);
bool is_directory(const std::string& path);
// Creates the directory and every missing parent. Empty string on success,
// the error otherwise.
std::string make_dirs(const std::string& path);

std::string read_file(const std::string& path);
std::optional<std::string> read_file_checked(const std::string& path);
// First line of the file, reading at most `limit` bytes like the Go scanner.
std::optional<std::string> read_first_line(const std::string& path, std::size_t limit);
std::optional<std::string> first_line_of(const std::string& content, std::size_t limit);

bool write_file(const std::string& path, const std::string& data);

// Renames, returning "" or a human message. On Windows a sharing violation
// (the "Discord is still running" case) is translated into an actionable
// message instead of a bare errno.
std::string rename(const std::string& from, const std::string& to);
std::string remove_all(const std::string& path);

std::string get_env(const char* name);
std::string get_env_or(const char* name, const std::string& fallback);
std::optional<std::string> set_env(const char* name, const std::string& value);

// Per-OS user config directory, the same one go-appdir's UserConfig() gave.
std::string user_config_dir(const std::string& app_name);

// Title-cases the first letter, like the deprecated strings.Title the Go CLI
// used for the Discord picker.
std::string title(std::string value);

long current_uid();
bool is_root();

} // namespace util

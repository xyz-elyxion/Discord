/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey Installer, a cross platform gui/cli app for installing Limey
 * Copyright (c) 2023 Vendicated and Limey contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "util.hpp"

#include "log.hpp"

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <system_error>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace util {

std::string lower(std::string value) {
    for (char& c : value) {
        if (c >= 'A' && c <= 'Z') {
            c = static_cast<char>(c - 'A' + 'a');
        }
    }
    return value;
}

bool starts_with(const std::string& value, const std::string& prefix) {
    return value.compare(0, prefix.size(), prefix) == 0;
}

bool ends_with(const std::string& value, const std::string& suffix) {
    if (suffix.size() > value.size()) {
        return false;
    }
    return value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

std::string trim(const std::string& value) {
    const char* spaces = " \t\n\r\f\v";
    const auto begin = value.find_first_not_of(spaces);
    if (begin == std::string::npos) {
        return "";
    }
    const auto end = value.find_last_not_of(spaces);
    return value.substr(begin, end - begin + 1);
}

std::vector<std::string> split(const std::string& value, char separator) {
    std::vector<std::string> parts;
    std::string current;
    for (char c : value) {
        if (c == separator) {
            parts.push_back(current);
            current.clear();
        } else {
            current.push_back(c);
        }
    }
    parts.push_back(current);
    return parts;
}

std::string repeat(const std::string& value, std::size_t times) {
    std::string out;
    out.reserve(value.size() * times);
    for (std::size_t i = 0; i < times; ++i) {
        out += value;
    }
    return out;
}

std::string join(const std::string& a, const std::string& b) {
    if (a.empty()) {
        return b;
    }
    if (b.empty()) {
        return a;
    }
    std::string out = a;
    while (!out.empty() && (out.back() == '/' || out.back() == '\\')) {
        out.pop_back();
    }
    return out + "/" + b;
}

std::string join(const std::vector<std::string>& parts) {
    std::string out;
    for (const auto& part : parts) {
        out = join(out, part);
    }
    return out;
}

std::string dir(const std::string& path) {
    const auto pos = path.find_last_of("/\\");
    if (pos == std::string::npos) {
        return ".";
    }
    if (pos == 0) {
        return path.substr(0, 1);
    }
    return path.substr(0, pos);
}

std::string base(const std::string& path) {
    std::string trimmed = path;
    while (trimmed.size() > 1 && (trimmed.back() == '/' || trimmed.back() == '\\')) {
        trimmed.pop_back();
    }
    const auto pos = trimmed.find_last_of("/\\");
    if (pos == std::string::npos) {
        return trimmed;
    }
    return trimmed.substr(pos + 1);
}

bool exists_file(const std::string& path) {
    std::error_code ec;
    const bool exists = std::filesystem::exists(path, ec);
    logging::debug(std::string("Checking if ") + path + " exists: " + (exists ? "Yes" : "No"));
    return exists && !ec;
}

bool is_directory(const std::string& path) {
    std::error_code ec;
    const bool is_dir = std::filesystem::is_directory(path, ec);
    if (ec) {
        logging::error(std::string("Error while checking if ") + path + " is directory: " + ec.message());
        return false;
    }
    logging::debug(std::string("Checking if ") + path + " is directory: " + (is_dir ? "Yes" : "No"));
    return is_dir;
}

std::string make_dirs(const std::string& path) {
    std::error_code ec;
    std::filesystem::create_directories(path, ec);
    if (ec && !std::filesystem::is_directory(path)) {
        return ec.message();
    }
    return "";
}

std::string read_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        return "";
    }
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

std::optional<std::string> read_file_checked(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        return std::nullopt;
    }
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

std::optional<std::string> first_line_of(const std::string& content, std::size_t limit) {
    const std::size_t readable = content.size() < limit ? content.size() : limit;
    const std::string window = content.substr(0, readable);
    const auto newline = window.find('\n');
    if (newline == std::string::npos) {
        if (window.empty()) {
            return std::nullopt;
        }
        return window;
    }
    return window.substr(0, newline);
}

std::optional<std::string> read_first_line(const std::string& path, std::size_t limit) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        return std::nullopt;
    }
    std::string line;
    if (!std::getline(file, line)) {
        return std::nullopt;
    }
    if (line.size() > limit) {
        line = line.substr(0, limit);
    }
    if (!line.empty() && line.back() == '\r') {
        line.pop_back();
    }
    return line;
}

bool write_file(const std::string& path, const std::string& data) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    if (!file) {
        return false;
    }
    file.write(data.data(), static_cast<std::streamsize>(data.size()));
    return file.good();
}

std::string rename(const std::string& from, const std::string& to) {
    std::error_code ec;
    std::filesystem::rename(from, to, ec);
    if (!ec) {
        return "";
    }

#ifdef _WIN32
    // ERROR_SHARING_VIOLATION (32) means Discord still has the file open.
    if (ec.value() == 32 || ec.value() == 5 /* ERROR_ACCESS_DENIED */) {
        return "Cannot patch because Discord's files are used by a different process.\n"
               "Make sure you close Discord before trying to patch!";
    }
#endif

    return ec.message();
}

std::string remove_all(const std::string& path) {
    std::error_code ec;
    std::filesystem::remove_all(path, ec);
    return ec ? ec.message() : "";
}

std::string get_env(const char* name) {
    const char* value = std::getenv(name);
    return value == nullptr ? "" : value;
}

std::string get_env_or(const char* name, const std::string& fallback) {
    const std::string value = get_env(name);
    return value.empty() ? fallback : value;
}

std::optional<std::string> set_env(const char* name, const std::string& value) {
#ifdef _WIN32
    return _putenv_s(name, value.c_str()) == 0 ? std::optional<std::string>(value)
                                               : std::nullopt;
#else
    return setenv(name, value.c_str(), 1) == 0 ? std::optional<std::string>(value)
                                               : std::nullopt;
#endif
}

std::string user_config_dir(const std::string& app_name) {
#if defined(_WIN32)
    const std::string app_data = get_env("APPDATA");
    return join(app_data, app_name);
#elif defined(__APPLE__)
    const std::string home = get_env("HOME");
    return join(join(home, "Library/Application Support"), app_name);
#else
    const std::string xdg = get_env("XDG_CONFIG_HOME");
    if (!xdg.empty()) {
        return join(xdg, app_name);
    }
    return join(join(get_env("HOME"), ".config"), app_name);
#endif
}

std::string title(std::string value) {
    if (!value.empty() && value[0] >= 'a' && value[0] <= 'z') {
        value[0] = static_cast<char>(value[0] - 'a' + 'A');
    }
    return value;
}

long current_uid() {
#ifdef _WIN32
    return 0;
#else
    return static_cast<long>(getuid());
#endif
}

bool is_root() {
#ifdef _WIN32
    return false;
#else
    return geteuid() == 0;
#endif
}

} // namespace util

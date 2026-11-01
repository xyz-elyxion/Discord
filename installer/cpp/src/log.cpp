/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "log.hpp"

#include <cstdio>
#include <cstdlib>

#ifdef _WIN32
#include <io.h>
#define LIMEY_FILENO _fileno
#define LIMEY_ISATTY _isatty
#else
#include <unistd.h>
#define LIMEY_FILENO fileno
#define LIMEY_ISATTY isatty
#endif

namespace logging {
namespace {

Level g_level = Level::Info;

const char* level_name(Level level) {
    switch (level) {
    case Level::Debug:
        return "DEBUG";
    case Level::Info:
        return "INFO";
    case Level::Warn:
        return "WARN";
    case Level::Error:
        return "ERROR";
    case Level::Fatal:
        return "FATAL";
    }
    return "INFO";
}

// fatih/color dropped colour when stderr was not a terminal; keep that so
// piped output and CI logs stay readable.
const char* level_color(Level level) {
    switch (level) {
    case Level::Debug:
        return "\x1b[36m"; // cyan
    case Level::Info:
        return "\x1b[34m"; // blue
    case Level::Warn:
        return "\x1b[33m"; // yellow
    case Level::Error:
        return "\x1b[31m"; // red
    case Level::Fatal:
        return "\x1b[91m"; // bright red
    }
    return "";
}

bool use_color() {
    static const bool enabled = LIMEY_ISATTY(LIMEY_FILENO(stderr)) != 0;
    return enabled;
}

} // namespace

void set_level(Level level) {
    g_level = level;
}

Level level() {
    return g_level;
}

void log(Level level, const std::string& message) {
    if (level < g_level) {
        return;
    }

    // Go padded the level name to len("error") so the message column lines up.
    std::string name = level_name(level);
    while (name.size() < 5) {
        name.push_back(' ');
    }

    if (use_color()) {
        std::fprintf(stderr, "%s%s\x1b[0m %s\n", level_color(level), name.c_str(), message.c_str());
    } else {
        std::fprintf(stderr, "%s %s\n", name.c_str(), message.c_str());
    }
    std::fflush(stderr);
}

void debug(const std::string& message) {
    log(Level::Debug, message);
}

void info(const std::string& message) {
    log(Level::Info, message);
}

void warn(const std::string& message) {
    log(Level::Warn, message);
}

void error(const std::string& message) {
    log(Level::Error, message);
}

void fatal(const std::string& message) {
    log(Level::Fatal, message);
    std::exit(1);
}

} // namespace logging

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "http.hpp"

#include "buildinfo.hpp"
#include "log.hpp"
#include "util.hpp"

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

#ifdef _WIN32
#define LIMEY_POPEN _popen
#define LIMEY_PCLOSE _pclose
#else
#define LIMEY_POPEN popen
#define LIMEY_PCLOSE pclose
#endif

namespace http {
namespace {

// Temporary file names are unique per process and request so two parallel
// downloads in the same run cannot clobber each other.
std::string temp_path(const char* suffix) {
    static std::atomic<unsigned long> counter{0};
    std::error_code ec;
    const auto dir = std::filesystem::temp_directory_path(ec);
    const std::string base = ec ? std::string(".") : dir.string();
    std::ostringstream name;
    name << base << "/limey-installer-" << util::current_uid() << "-"
         << reinterpret_cast<std::uintptr_t>(&counter) << "-" << counter.fetch_add(1)
         << suffix;
    return name.str();
}

std::string quote(const std::string& value) {
    std::string out = "\"";
    for (char c : value) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
        }
        out.push_back(c);
    }
    out.push_back('"');
    return out;
}

std::string read_and_remove(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        return "";
    }
    std::ostringstream buffer;
    buffer << file.rdbuf();
    file.close();
    std::error_code ec;
    std::filesystem::remove(path, ec);
    return buffer.str();
}

std::string user_agent() {
    return std::string("LimeyV1Installer/") + buildinfo::InstallerVersion;
}

} // namespace

Response get(const std::string& url) {
    Response response;

    const std::string body_path = temp_path(".body");
    const std::string status_path = temp_path(".status");
    const std::string error_path = temp_path(".err");

    // -L follows the redirects the backend uses for release assets, -s keeps
    // curl's progress bar off stderr. No -f: we want the real HTTP status so
    // a 404/503 becomes the same "failed to download <file>" the Go version
    // reported instead of a generic curl exit code.
    std::ostringstream cmd;
    cmd << "curl -sS -L --connect-timeout 15 --max-time 120 -A " << quote(user_agent())
        << " -o " << quote(body_path) << " -w \"%{http_code}\" " << quote(url)
        << " > " << quote(status_path) << " 2> " << quote(error_path);

    const int exit_code = std::system(cmd.str().c_str());

    const std::string status_text = util::trim(read_and_remove(status_path));
    const std::string error_text = util::trim(read_and_remove(error_path));
    response.body = read_and_remove(body_path);

    if (!status_text.empty()) {
        response.status = std::strtol(status_text.c_str(), nullptr, 10);
    }

    if (exit_code != 0) {
        std::string message = error_text.empty() ? "curl failed" : error_text;
        // curl prefixes its messages with "curl: (N) "; keep it, it names the
        // real problem (6 = DNS, 7 = refused, 35 = TLS, ...).
        response.body.clear();
        response.status = 0;
        response.error = message;
        return response;
    }

    if (!error_text.empty()) {
        // curl succeeded but still wrote a warning; the download is valid.
        logging::debug("curl: " + error_text);
    }

    return response;
}

} // namespace http

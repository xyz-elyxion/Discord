/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#pragma once

#include <string>

namespace http {

struct Response {
    // 0 when the transfer never gave us a status (file:// URLs, connection
    // failures). Anything >= 300 is treated as a failure by the callers, the
    // same way the Go installer checked res.StatusCode.
    long status = 0;
    std::string body;
    std::string error; // empty when the request succeeded

    bool ok() const { return error.empty(); }
};

// GETs a URL through the system `curl`, which ships with Windows 10+,
// macOS and every mainstream Linux distribution. Doing it this way instead
// of linking libcurl keeps the installer a single self-contained binary on
// three platforms with no build-time dependencies.
Response get(const std::string& url);

} // namespace http

/*
 * SPDX-License-Identifier: GPL-3.0
 * Limey V1 Installer, a cross platform cli app for installing Limey V1
 * Copyright (c) 2026 Limey V1 contributors
 */

#include "asar.hpp"

#include "util.hpp"

#include <cstdint>
#include <cstdio>
#include <string>

namespace asar {

const char* PackageJson = "{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}";

namespace {

void append_u32_le(std::string& out, std::uint32_t value) {
    out.push_back(static_cast<char>(value & 0xff));
    out.push_back(static_cast<char>((value >> 8) & 0xff));
    out.push_back(static_cast<char>((value >> 16) & 0xff));
    out.push_back(static_cast<char>((value >> 24) & 0xff));
}

} // namespace

std::string json_string(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        switch (c) {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        case '<':
            out += "\\u003c";
            break;
        case '>':
            out += "\\u003e";
            break;
        case '&':
            out += "\\u0026";
            break;
        default:
            if (c < 0x20) {
                char escaped[7];
                std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
                out += escaped;
            } else {
                out.push_back(static_cast<char>(c));
            }
        }
    }
    out += "\"";
    return out;
}

std::string write_app_asar(const std::string& out_file, const std::string& patcher_path) {
    // index.js just requires the patcher; the two file bodies are packed
    // back to back and the header records their sizes and offsets.
    const std::string index_js = "require(" + json_string(patcher_path) + ")";
    const std::string package_json = PackageJson;

    // Go marshalled map[string]map[string]asarEntry, which sorts keys, and
    // the entry struct as {"size":N,"offset":"..."}.
    std::string header = "{\"files\":{";
    header += "\"index.js\":{\"size\":" + std::to_string(index_js.size()) + ",\"offset\":\"0\"},";
    header += "\"package.json\":{\"size\":" + std::to_string(package_json.size()) +
              ",\"offset\":\"" + std::to_string(index_js.size()) + "\"}";
    header += "}}";

    const std::uint32_t header_string_size = static_cast<std::uint32_t>(header.size());
    const std::uint32_t data_size = 4;
    const std::uint32_t aligned_size = (header_string_size + data_size - 1) & ~(data_size - 1);
    const std::uint32_t header_size = aligned_size + 8;
    const std::uint32_t header_object_size = aligned_size + data_size;

    // The header is padded with '0' up to the 4-byte aligned length; that is
    // what the asar format expects between the JSON and the file data.
    if (aligned_size > header_string_size) {
        header += util::repeat("0", aligned_size - header_string_size);
    }

    std::string out;
    out.reserve(16 + header.size() + index_js.size() + package_json.size());
    append_u32_le(out, data_size);
    append_u32_le(out, header_size);
    append_u32_le(out, header_object_size);
    append_u32_le(out, header_string_size);
    out += header;
    out += index_js;
    out += package_json;

    if (!util::write_file(out_file, out)) {
        return "Failed to create " + out_file;
    }
    return "";
}

} // namespace asar

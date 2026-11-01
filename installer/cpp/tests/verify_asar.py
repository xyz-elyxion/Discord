#!/usr/bin/env python3
"""Checks the C++ asar writer against an independent implementation.

Run via `make test`; the first argument is the asar-dump binary. The expected
bytes are rebuilt here from the asar layout description instead of from the
C++ code, so a wrong alignment, padding byte or offset shows up as a diff.
"""

import json
import os
import struct
import subprocess
import sys
import tempfile

PACKAGE_JSON = '{\n\t"name": "discord",\n\t"main": "index.js"\n}'


def go_json_string(value):
    """Go's encoding/json string escaping for the paths we test."""
    encoded = json.dumps(value, ensure_ascii=False)
    return encoded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def expected_asar(patcher_path):
    index_js = "require(" + go_json_string(patcher_path) + ")"
    index_bytes = index_js.encode()
    package_bytes = PACKAGE_JSON.encode()

    header = (
        '{"files":{'
        '"index.js":{"size":%d,"offset":"0"},'
        '"package.json":{"size":%d,"offset":"%d"}'
        "}}"
    ) % (len(index_bytes), len(package_bytes), len(index_bytes))

    header_size_bytes = len(header.encode())
    data_size = 4
    aligned = (header_size_bytes + data_size - 1) & ~(data_size - 1)
    header_size = aligned + 8
    header_object_size = aligned + data_size
    padded_header = header + "0" * (aligned - header_size_bytes)

    prefix = struct.pack("<IIII", data_size, header_size, header_object_size, header_size_bytes)
    return prefix + padded_header.encode() + index_bytes + package_bytes, padded_header, index_bytes, package_bytes


def check(condition, message):
    if not condition:
        print("FAIL: " + message, file=sys.stderr)
        sys.exit(1)
    print("ok - " + message)


def main():
    if len(sys.argv) != 2:
        print("usage: verify_asar.py <asar-dump-binary>", file=sys.stderr)
        return 2

    dump = os.path.abspath(sys.argv[1])

    paths = [
        "/home/ve/.config/LimeyV1/dist/patcher.js",
        "C:\\Users\\t\u00ebst User\\AppData\\Roaming\\LimeyV1\\dist\\patcher.js",
    ]

    with tempfile.TemporaryDirectory() as tmp:
        for i, patcher_path in enumerate(paths):
            out_file = os.path.join(tmp, "app-%d.asar" % i)
            subprocess.run([dump, out_file, patcher_path], check=True)

            actual = open(out_file, "rb").read()
            expected, padded_header, index_bytes, package_bytes = expected_asar(patcher_path)

            check(actual == expected, "asar bytes match for %r" % patcher_path)

            data_size, header_size, header_object_size, header_string_size = struct.unpack(
                "<IIII", actual[:16]
            )
            check(data_size == 4, "data size prefix is 4 for %r" % patcher_path)
            check(header_string_size == len(padded_header.encode()),
                  "header string size counts the padded JSON for %r" % patcher_path)
            check(header_size == header_object_size + 4,
                  "header size is the object size plus the size fields for %r" % patcher_path)

            header = json.loads(actual[16:16 + header_string_size].decode().rstrip("0"))
            files = header["files"]
            check(files["index.js"]["size"] == len(index_bytes), "index.js size recorded")
            check(files["index.js"]["offset"] == "0", "index.js offset is 0")
            check(files["package.json"]["size"] == len(package_bytes), "package.json size recorded")
            check(files["package.json"]["offset"] == str(len(index_bytes)),
                  "package.json offset follows index.js")
            check(actual.endswith(package_bytes), "package.json bytes are last")

    print("asar writer verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())

// Test helper: writes a custom app.asar and exits. verify_asar.py runs this
// with a POSIX and a Windows-style patcher path and compares the bytes to an
// independent implementation of the format.

#include "../src/asar.hpp"

#include <cstdio>

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: asar-dump <out-file> <patcher-path>\n");
        return 2;
    }

    const std::string error = asar::write_app_asar(argv[1], argv[2]);
    if (!error.empty()) {
        std::fprintf(stderr, "%s\n", error.c_str());
        return 1;
    }
    return 0;
}

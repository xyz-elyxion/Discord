// Soft assert handler for the vendored imgui (see imconfig.h "soft asserts").
//
// The default IM_ASSERT maps to C assert(), which on Windows shows the fatal
// "Microsoft Visual C++ Runtime Library / Assertion failed!" dialog and kills
// the installer. Instead we:
//   1. output the violated expression + file/line to the debug console (and a
//      small capped log file on Windows) so we can diagnose the real underflow,
//   2. return, letting the caller continue — imgui.h's ImVector::front/back
//      were patched to fall back to a zero-value sentinel, so empty-stack
//      reads/writes stay inside valid memory.
// (c) 2026 Limey V1 contributors — SPDX-License-Identifier: GPL-3.0

#include <cstdio>
#include <cstdlib>
#include <cstdarg>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#endif

extern "C" void imguiAssertHandler(int result, const char *expr, const char *file, int line) {
    if (result) {
        return;
    }

    char msg[192];
    std::snprintf(msg, sizeof(msg), "imgui soft-assert: %s (%s:%d)\n",
                  expr ? expr : "?", file ? file : "?", line);

#ifdef _WIN32
    OutputDebugStringA(msg);
#endif

    // Cap the diagnostic file so a per-frame assert cannot balloon it.
    static int logged = 0;
#ifdef _WIN32
    if (logged < 128) {
        const char *tmp = std::getenv("TEMP");
        char path[MAX_PATH];
        if (tmp && *tmp) {
            std::snprintf(path, sizeof(path), "%s\\limey-v1-imgui-assert.log", tmp);
        } else {
            std::snprintf(path, sizeof(path), "C:\\Users\\Public\\limey-v1-imgui-assert.log");
        }
        if (FILE *f = std::fopen(path, "a")) {
            std::fputs(msg, f);
            std::fclose(f);
        }
    }
#else
    std::fputs(msg, stderr);
#endif
    logged++;
}

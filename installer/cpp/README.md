# Limey V1 installer — C++ port

C++17 rewrite of the Go installer (`../`, i.e. `installer/*.go`). No
third-party libraries: it builds with a stock `g++`/`clang++` on Linux,
macOS and (via mingw-w64) Windows, which the Go build needed a whole
toolchain and cgo GUI stack for.

```
make            # build/LimeyV1Installer for the host
make test       # logic + asar byte-layout tests
make windows    # build/LimeyV1Installer-cli-win.exe (needs x86_64-w64-mingw32-g++)
```

## Layout

| File | Ported from |
| --- | --- |
| `src/cli.cpp` | `cli.go`, `cli_windows.go`, `cli_other.go` |
| `src/downloader.cpp` | `downloader.go` — hash stamps, channels, parallel build download |
| `src/patcher.cpp` | `patcher.go` — `app.asar` swapping, flatpak override, rollback |
| `src/asar.cpp` | `app_asar.go` — the custom `app.asar` writer |
| `src/discord_linux.cpp` / `_windows.cpp` / `_darwin.cpp` | `find_discord_*.go` |
| `src/discord_common.cpp` | branch detection, broken-install warning |
| `src/paths.cpp` | the directory resolution that lived in `patcher.go`'s `init()` |
| `src/http.cpp` | the `net/http` calls |
| `src/log.cpp`, `src/util.cpp`, `src/buildinfo.hpp` | `log.go`, `util.go`, `buildinfo/` |
| `src/self_updater.cpp` | `self_updater.go` (disabled on purpose, same messages) |

## Decisions worth knowing

- **HTTP goes through the system `curl` binary**, not libcurl. Linking
  libcurl would add a build-time dependency on all three platforms; `curl`
  ships with Windows 10+, macOS and every mainstream Linux distribution.
  `src/http.cpp` writes the body to a temp file and reads the status code
  back, so `>= 300` is still reported the way the Go code reported it.
  `LIMEY_INSTALLER_BASE_URL` with a `file://` URL is how `make test` drives
  the whole download path without touching the network.
- **`LIMEY_DEV_INSTALL`** keeps its meaning: skip every download.
- **The build-check latch** replaces the Go installer's 1-buffered
  `BuildDoneChan`. Same "wait for the first hash check, get its result"
  barrier, but a later `set()` cannot deadlock a run that never read it.
- **The installed hash is read after the data directory is resolved.** The Go
  version ran that check from `downloader.go`'s `init()`, which happens before
  `patcher.go`'s `init()` sets `FilesDir`, so it looked for `patcher.js` in the
  working directory and always reported "None". Same observable behaviour on a
  fresh machine, correct behaviour on a patched one.
- **The picker asks for a number.** `promptui` needed arrow keys and a TTY;
  numbers work when input is piped, and the label text is accepted too.
  `--location`, `--branch` and `--auto` behave exactly as before.

## Not ported yet

- **The GUI** (`gui.go`, `gui_theme.go`, `gui_colors.go`). It was built on
  `giu`/`imgui-go` and a GLFW + OpenGL backend; `third_party/imgui-go` only
  vendors Dear ImGui's C++ core, not the platform/renderer backends, so the
  GUI needs a backend decision (Win32 + DirectX 11 for the Windows-only exe)
  before it can be written. Until then the Windows GUI installer is still
  built from the Go sources.
- **CI wiring.** `.github/workflows/release.yml` still builds all five
  installer binaries with `go build`. Switching the four CLI binaries over
  needs two changes: mingw for the Windows CLI (already installed in that
  step) and a `macos-latest` job, because `go build` could cross-compile the
  two macOS CLIs from Linux for free and a C++ toolchain cannot.

## What is verified and what is not

`make test` covers the hash stamps, channel validation, URL routing, the
channel marker, the empty-download and missing-file failure paths, and a full
download run against a `file://` backend — plus the `app.asar` bytes compared
against an independent implementation of the format (POSIX and Windows paths,
including the JSON escaping of backslashes).

A manual run on Linux patched a fake install (`resources/app.asar` swapped for
the generated one, `_app.asar` backed up, `channel.txt` written) and
uninstalled it back to the original bytes.

Not verified here: the Windows and macOS code paths (no cross-compiler in this
sandbox, no Discord of either kind), `--update-self`, and flatpak/system-electron
installs.

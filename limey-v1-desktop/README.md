# Limey V1 Desktop

Limey V1 Desktop is a custom Discord desktop app — a fork of
[Vesktop](https://github.com/Vencord/Vesktop) that ships the Limey V1 client
mod instead of Vencord. The client-mod files are served by the Limey backend
(https://limey-discord.onrender.com), the same source of truth the Limey V1
installer uses.

**Main features**:
- Limey V1 preinstalled
- Much more lightweight and faster than the official Discord app
- Linux Screenshare with sound & wayland
- Much better privacy, since Discord has no access to your system

**Not yet supported**:
- Global Keybinds
- see the [Roadmap](https://github.com/xyz-elyxion/Discord/issues/324)

## Installing

Visit https://limey-discord.onrender.com/download

## Building from Source

You need to have the following dependencies installed:
- [Git](https://git-scm.com/downloads)
- [Node.js](https://nodejs.org/en/download)
- pnpm: `npm install --global pnpm`

Packaging will create builds in the dist/ folder

```sh
git clone https://github.com/xyz-elyxion/Discord
cd Discord/limey-v1-desktop

# Install Dependencies
pnpm i

# Either run it without packaging
pnpm start

# Or package (will build packages for your OS)
pnpm package

# Or only build the Linux Pacman package
pnpm package --linux pacman

# Or package to a directory only
pnpm package:dir
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `LIMEY_DESKTOP_BASE_URL` | Override the Limey backend the client-mod files are downloaded from (defaults to https://limey-discord.onrender.com). |
| `LIMEY_REPAIR=1` | Force re-downloading the client-mod files at next startup (same as running the app with `--repair`). |
| `LIMEY_USER_DATA_DIR` | Override the user-data directory. |

## Building LibLimey from Source

This is a small C++ helper library Limey V1 Desktop uses on Linux to emit D-Bus events. By default, prebuilt binaries for x64 and arm64 are used.

If you want to build it from source:
1. Install build dependencies:
    - Debian/Ubuntu: `apt install build-essential python3 curl pkg-config libglib2.0-dev`
    - Fedora: `dnf install @c-development @development-tools python3 curl pkgconf-pkg-config glib2-devel`
2. Run `pnpm buildLibLimey`
3. From now on, building Limey V1 Desktop will use your own build

## Attribution & License

Limey V1 Desktop is based on [Vesktop](https://github.com/Vencord/Vesktop) by
Vendicated and contributors, which itself builds on
[Vencord](https://github.com/Vendicated/Vencord). Upstream copyright notices
are preserved throughout the source. All changes are licensed under the same
license — see [LICENSE](./LICENSE).

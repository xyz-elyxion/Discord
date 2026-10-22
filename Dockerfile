# ---------- Cloud backend (Go) ----------
FROM golang:1.27-alpine AS cloud
WORKDIR /cloud
COPY cloud/go.mod cloud/go.sum ./
RUN go mod download
COPY cloud .
RUN CGO_ENABLED=0 go build -o limeycloud-backend .

# ---------- Limey V1 Installer (Go CLI + Windows GUI) ----------
FROM golang:1.27-alpine AS installer
WORKDIR /installer
# mingw is needed to cross-compile the cgo-based GUI installer for Windows
RUN apk add --no-cache mingw-w64-gcc
COPY installer/go.mod installer/go.sum ./
# The installer module force-replaces imgui-go with our vendored fork
# (soft-assert patch, see third_party/imgui-go) — at /installer that relative
# path resolves to /third_party/imgui-go, so copy it there too.
COPY third_party /third_party
RUN go mod download
COPY installer .
# Cross-compile the GUI installer (Windows .exe) and static CLI installers
# for Windows, macOS (Intel + Apple Silicon) and Linux
RUN CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++ GOOS=windows GOARCH=amd64 go build -ldflags "-H windowsgui -s -w" -o /LimeyV1Installer.exe . \
 && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags cli -ldflags "-s -w -extldflags=-static" -o /LimeyV1Installer-cli-win.exe . \
 && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -tags cli -ldflags "-s -w" -o /LimeyV1Installer-cli-macos-arm64 . \
 && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -tags cli -ldflags "-s -w" -o /LimeyV1Installer-cli-macos-amd64 . \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags cli -ldflags "-s -w -extldflags=-static" -o /LimeyV1Installer-cli-linux .

# ---------- Limebot (Discord bot) ----------
FROM node:22-alpine AS limebot

# Build tools for native modules (better-sqlite3, sharp) if no prebuild matches
RUN apk add --no-cache python3 make g++

WORKDIR /bot

RUN corepack enable

COPY limebot/package.json limebot/pnpm-lock.yaml ./
COPY limebot ./

# Ignore scripts at install time (the root postinstall needs the sqlite3 CLI,
# which we don't want in the image), then rebuild only the packages that ship
# native bindings so their prebuild/compile scripts actually run.
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild better-sqlite3 sharp
RUN node scripts/build.mjs

# ---------- Limey V1 Desktop (standalone Electron client) ----------
# Builds the rebranded Vesktop fork in limey-v1-desktop/: esbuild bundles the
# app's main/preload/renderer/splash/updater scripts into /desktop/dist.
# No Electron runtime scripts are needed for bundling, so install with
# --ignore-scripts (electron binaries are fetched per-target by
# electron-builder at package time) and rebuild esbuild, which ships a
# platform binary. Debian (glibc) rather than Alpine: electron-builder's
# native packers (app-builder, AppImage toolset) need glibc; musl breaks them.
FROM node:22-slim AS desktop
WORKDIR /desktop

RUN corepack enable

COPY limey-v1-desktop/package.json limey-v1-desktop/pnpm-lock.yaml limey-v1-desktop/pnpm-workspace.yaml ./
COPY limey-v1-desktop/patches ./patches
COPY limey-v1-desktop/packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

# .dockerignore keeps the context lean (node_modules/ and dist/ never match),
# so this copies clean source; the build regenerates dist/ in-image.
COPY limey-v1-desktop ./
RUN pnpm build \
    && test -f dist/js/main.js && test -f dist/js/renderer.js && test -f dist/js/preload.js

# Package real installers next to the plain bundles, all built in-image:
#  - Linux: AppImage + .tar.gz (both arches from the electron-builder config)
#  - Windows: portable .zip (unzip & run; no NSIS/Wine needed for zip targets)
# Packaging pulls the per-target Electron dist zips itself. --publish never:
# artifacts must stay local to the image, not be uploaded anywhere.
RUN pnpm exec electron-builder --linux AppImage tar.gz --publish never \
    && pnpm exec electron-builder --win zip --x64 --publish never

# Drop unpacked intermediates electron-builder leaves behind — the installers
# are what ships; linux-unpacked/win-unpacked just inflate the image.
RUN rm -rf dist/linux-unpacked dist/win-unpacked dist/*.blockmap dist/builder-debug.yml dist/builder-effective-config.yaml

# ---------- Ghost Client overlay (Electron EXE) ----------
# Builds the Prestige-style overlay app (ghost-client-app/) into a portable
# Windows zip. Cross-compiled on Linux: electron-builder just downloads the
# win32-x64 Electron dist and zips it, so no Wine is needed for the zip target.
FROM node:22-slim AS ghost-client

WORKDIR /ghost

RUN corepack enable

# app-builder downloads the electron win32-x64 dist with a parallel-part
# downloader that some CI hosts (Render et al.) rate-limit or block. Use the
# npmmirror CDN mirror instead and pre-fetch the zip into electron-builder's
# cache with retries, so the in-builder download short-circuits entirely.
ENV ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
ENV XDG_CACHE_HOME=/node/.cache

COPY ghost-client-app/package.json ./

# electron's postinstall grabs a ~100MB binary we never run locally and it
# needs no scripts at build time (the correct dist is pre-fetched below).
RUN pnpm install --frozen-lockfile=false --ignore-scripts

# Pre-fetch the electron win32-x64 dist into electron-builder's cache from the
# npmmirror CDN with retries — app-builder's own GitHub release download gets
# rate-limited/blocked on some CI hosts and would kill the whole build.
# Living in the app repo's scripts/ keeps the Dockerfile parser-friendly
# (no multi-line inline scripts) and testable outside Docker.
COPY ghost-client-app/scripts/fetch-electron-dist.mjs ./scripts/fetch-electron-dist.mjs
RUN node scripts/fetch-electron-dist.mjs

COPY ghost-client-app ./
RUN pnpm build:win \
    && test -f dist/LimeyV1GhostClient-win-x64-1.0.0.zip

# ---------- Build stage ----------
FROM node:22-alpine AS build

WORKDIR /app

# Enable corepack for pnpm (version comes from package.json packageManager field)
RUN corepack enable

# Install dependencies first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/discord-types/package.json packages/discord-types/package.json
COPY packages/limeyV1-types/package.json packages/limeyV1-types/package.json
RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build the web bundle (userscript + browser.js).
# No git needed: the build falls back to the production remote when git is absent.
COPY . .
RUN pnpm buildWeb --standalone
# Build the Discord Desktop App artifacts (patcher/renderer/preload) so the
# runtime server can serve /v1/install/desktop as built without compiling.
# --standalone marks these as official release builds: without it the client
# self-identifies as a "DevBuild" (support warnings, git updater active),
# which is wrong for builds served to end users.
RUN pnpm build --standalone
# Package the browser extension built above (dist/browser.js + dist/browser.css)
# with the browser/ extension shell into dist/LimeyV1-Extension.zip so the image
# ships a ready-to-install extension at /dist/LimeyV1-Extension.zip. Idempotent:
# zipExtension.mjs re-reads the current dist output; `test` fails the build if
# the zip is ever missing.
RUN node scripts/zipExtension.mjs && test -f dist/LimeyV1-Extension.zip
# Stage fflate (used by server.js to package the extension zip in-process),
# undici (used by server.js to validate the limebot proxy at startup) and pg
# (PostgreSQL kv persistence). pnpm hoists only direct deps to the top level,
# so install pg cleanly with npm instead of copying its transitive tree.
RUN mkdir -p /app/runtime_deps/node_modules \
    && cp -rL /app/node_modules/fflate /app/runtime_deps/node_modules/ \
    && cp -rL /app/node_modules/undici /app/runtime_deps/node_modules/ \
    && cd /app/runtime_deps \
    && echo '{"name":"limey-runtime-deps","private":true}' > package.json \
    && npm install --no-audit --no-fund --loglevel=error "pg@$(node -p "require('/app/node_modules/pg/package.json').version")"
# Generate the plugin catalog data for /plugins/
RUN pnpm generatePluginJson public/plugins.json public/readmes.json

# ---------- Runtime stage ----------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Writable data dirs (must run as root before switching to node):
# JSON persistence for usrbg/detector/reviewdb fallbacks (Redis is the primary
# store when REDIS_URI is set) and the limebot SQLite database.
RUN mkdir -p /app/data /app/limebot/data && chown -R node:node /app/data /app/limebot/data

# Release-channel snapshot dirs (lts/rc/beta/canary/alpha) inside /app/dist so
# the admin panel can freeze the container's built artifacts into a channel
# (POST /v1/admin/channels/<id>/publish) and subsequent renders of
# /v1/install/files/<channel>/* keep serving those snapshots.
# The Docker build stage builds ALL dist artifacts first (extension zip,
# desktop artfacts from build.mjs as in image build steps above, plugin
# catalog). Admin channel operations persist here for the container lifetime.
RUN mkdir -p /app/dist/lts /app/dist/rc /app/dist/beta /app/dist/canary /app/dist/alpha \
    && chown -R node:node /app/dist/lts /app/dist/rc /app/dist/beta /app/dist/canary /app/dist/alpha

# Run as a non-root user
USER node

# Copy only what the server needs
COPY --from=build --chown=node:node /app/package.json /app/server.js ./
COPY --from=build --chown=node:node /app/pgkv.js ./
COPY --from=build --chown=node:node /app/reviewdb-backend.js ./
COPY --from=build --chown=node:node /app/lime-economy-backend.js ./
COPY --from=build --chown=node:node /app/lime-pluginstore-backend.js ./
COPY --from=build --chown=node:node /app/sentinel-backend.js ./
COPY --from=build --chown=node:node /app/release-channels.js ./
COPY --from=build --chown=node:node /app/rollouts.js ./
COPY --from=build --chown=node:node /app/runtime_deps/node_modules ./node_modules
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
# Limey V1 Desktop standalone app (built by the desktop stage): bundles, views
# and manifest under /dist/limeyDesktop. /dist/limeyDesktop/* serves the raw
# build files and /v1/install/desktop-app serves the packaged installers.
COPY --from=desktop --chown=node:node /desktop/dist /app/dist/limeyDesktop/dist
COPY --from=desktop --chown=node:node /desktop/static /app/dist/limeyDesktop/static
COPY --from=desktop --chown=node:node /desktop/package.json /app/dist/limeyDesktop/package.json
# Full browser/ extension shell so the server can package the install zip itself
COPY --from=build --chown=node:node /app/browser ./browser
COPY --from=cloud --chown=node:node /cloud/limeycloud-backend ./cloud/limeycloud-backend
COPY --from=installer --chown=node:node /LimeyV1Installer.exe ./dist/LimeyV1Installer.exe
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-win.exe ./dist/LimeyV1Installer-cli-win.exe
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-macos-arm64 ./dist/LimeyV1Installer-cli-macos-arm64
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-macos-amd64 ./dist/LimeyV1Installer-cli-macos-amd64
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-linux ./dist/LimeyV1Installer-cli-linux
# Ghost Client overlay EXE (portable Windows zip) for download
COPY --from=ghost-client --chown=node:node /ghost/dist/*.zip ./dist/
COPY --from=limebot --chown=node:node /bot/dist ./limebot/dist
COPY --from=limebot --chown=node:node /bot/node_modules ./limebot/node_modules
COPY --from=limebot --chown=node:node /bot/package.json ./limebot/package.json
COPY --from=limebot --chown=node:node /bot/assets ./limebot/assets
# Limebot needs its SQLite database to exist with tables before it starts
COPY --chown=node:node limebot/sql/create.sql ./limebot/sql/create.sql
RUN node -e "const d=require('/app/limebot/node_modules/better-sqlite3');const db=new d('/app/limebot/data/db.sqlite3');db.exec(require('fs').readFileSync('/app/limebot/sql/create.sql','utf8'));db.close();"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]

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
RUN pnpm buildWeb
# Build the Discord Desktop App artifacts (patcher/renderer/preload) so the
# runtime server can serve /v1/install/desktop as built without compiling.
RUN pnpm build
# Stage fflate (used by server.js to package the extension zip in-process)
RUN mkdir -p /app/runtime_deps/node_modules && cp -rL /app/node_modules/fflate /app/runtime_deps/node_modules/
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

# Run as a non-root user
USER node

# Copy only what the server needs
COPY --from=build --chown=node:node /app/package.json /app/server.js ./
COPY --from=build --chown=node:node /app/reviewdb-backend.js ./
COPY --from=build --chown=node:node /app/server-config-backend.js ./
COPY --from=build --chown=node:node /app/runtime_deps/node_modules ./node_modules
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
# Full browser/ extension shell so the server can package the install zip itself
COPY --from=build --chown=node:node /app/browser ./browser
COPY --from=cloud --chown=node:node /cloud/limeycloud-backend ./cloud/limeycloud-backend
COPY --from=installer --chown=node:node /LimeyV1Installer.exe ./dist/LimeyV1Installer.exe
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-win.exe ./dist/LimeyV1Installer-cli-win.exe
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-macos-arm64 ./dist/LimeyV1Installer-cli-macos-arm64
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-macos-amd64 ./dist/LimeyV1Installer-cli-macos-amd64
COPY --from=installer --chown=node:node /LimeyV1Installer-cli-linux ./dist/LimeyV1Installer-cli-linux
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

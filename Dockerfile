# ---------- Build stage ----------
FROM node:22-alpine AS build

WORKDIR /app

# Enable corepack for pnpm (version comes from package.json packageManager field)
RUN corepack enable

# Install dependencies first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/discord-types/package.json packages/discord-types/package.json
COPY packages/limeyV1-types/package.json packages/limeyV1-types/package.json
RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build the web bundle (userscript + browser.js)
COPY . .
RUN pnpm buildWeb

# ---------- Runtime stage ----------
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Run as a non-root user
USER node

# Copy only what the server needs
COPY --from=build --chown=node:node /app/package.json /app/server.js ./
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/browser/icon.png ./browser/icon.png

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]

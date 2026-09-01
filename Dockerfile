# ─────────────────────────────────────────────────────────────
# Cerebro — multi-stage build
# Builds shared types + React UI, then the NestJS server, and
# ships a single lean runtime image that serves both.
# ─────────────────────────────────────────────────────────────

# 1) Install all workspace deps once (cached)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm install

# 2) Build shared, web, and server
FROM node:22-alpine AS build
WORKDIR /app
ARG GIT_SHA=dev
ENV VITE_GIT_SHA=$GIT_SHA
ENV GIT_SHA=$GIT_SHA
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build --workspace @cerebro/shared \
 && npm run build --workspace @cerebro/web \
 && npm run prisma:generate --workspace @cerebro/server \
 && npm run build --workspace @cerebro/server
# Place built UI where the server serves static files from.
RUN mkdir -p apps/server/public && cp -r apps/web/dist/* apps/server/public/

# 3) Runtime — only production deps + built output
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# signal-cli version to bundle (https://github.com/AsamK/signal-cli/releases).
ARG SIGNAL_CLI_VERSION=0.13.11
# Prisma needs OpenSSL; restic drives the Backblaze B2 backup connector.
# signal-cli powers the Signal notification channel: it's a JVM app, so it needs
# a JRE, and its native libsignal lib is built for glibc — gcompat/libc6-compat
# provide the glibc shim so it runs on Alpine's musl. (If the native lib still
# fails to load on your host, switch this runtime stage to a debian-slim base.)
RUN apk add --no-cache openssl restic openjdk17-jre-headless gcompat libc6-compat wget \
 && wget -qO /tmp/signal-cli.tar.gz \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
 && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
 && ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli \
 && rm /tmp/signal-cli.tar.gz
# signal-cli account state (keys, registration) lives here — mount a volume.
ENV SIGNAL_CLI_CONFIG=/data/signal
RUN mkdir -p /data/signal
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/public ./apps/server/public
COPY --from=build /app/apps/server/prisma ./apps/server/prisma
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh
EXPOSE 3000
# entrypoint runs prisma migrate deploy + seed, then starts the server
ENTRYPOINT ["./docker/entrypoint.sh"]

# ─────────────────────────────────────────────────────────────
# Cerebro — multi-stage build
# Builds shared types + React UI, then the NestJS server, and
# ships a single runtime image that serves both.
#
# Base is Debian (bookworm-slim), NOT Alpine: signal-cli's native
# libsignal_jni is built for glibc and cannot resolve glibc-only symbols
# (e.g. __register_atfork) under Alpine's musl, even with gcompat. Debian
# also keeps Prisma's engine target (glibc) consistent across build & runtime.
# ─────────────────────────────────────────────────────────────

# 1) Install all workspace deps once (cached)
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
RUN npm install

# 2) Build shared, web, and server
FROM node:22-bookworm-slim AS build
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

# JRE source: signal-cli is a JVM app. 0.13.x needs Java 21; copy a Temurin JRE
# rather than chase Debian's default JDK version. Bump this alongside
# SIGNAL_CLI_VERSION if a future signal-cli requires a newer Java.
FROM eclipse-temurin:21-jre-jammy AS jre

# 3) Runtime — only production deps + built output
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# signal-cli version to bundle (https://github.com/AsamK/signal-cli/releases).
ARG SIGNAL_CLI_VERSION=0.13.11

# Java 21 (Temurin) for signal-cli.
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"

# openssl → Prisma engine; restic → Backblaze B2 backup connector;
# then download signal-cli and symlink it onto PATH.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl restic ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
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

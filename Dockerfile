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

# 3) Runtime — only production deps + built output
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# signal-cli version to bundle (https://github.com/AsamK/signal-cli/releases).
# Signal's servers reject clients that are too old (connection closed on link),
# so keep this reasonably current.
ARG SIGNAL_CLI_VERSION=0.14.7
# Java for signal-cli. 0.14.x requires JRE 25. A newer JRE still runs older
# class files, so overshoot rather than risk UnsupportedClassVersionError. We
# fetch Adoptium's portable generic-linux JRE (conservative glibc baseline), so
# it runs on this Debian base regardless of the JRE's own build distro.
ARG JAVA_VERSION=25

# openssl → Prisma engine; restic → Backblaze B2 backup connector; then fetch a
# Temurin JRE (arch-matched) and signal-cli, and symlink signal-cli onto PATH.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl restic ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in amd64) JARCH=x64;; arm64) JARCH=aarch64;; *) JARCH="$ARCH";; esac \
 && wget -qO /tmp/jre.tar.gz \
      "https://api.adoptium.net/v3/binary/latest/${JAVA_VERSION}/ga/linux/${JARCH}/jre/hotspot/normal/eclipse" \
 && mkdir -p /opt/java \
 && tar -xzf /tmp/jre.tar.gz -C /opt/java --strip-components=1 \
 && rm /tmp/jre.tar.gz \
 && wget -qO /tmp/signal-cli.tar.gz \
      "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
 && tar -xzf /tmp/signal-cli.tar.gz -C /opt \
 && ln -sf "/opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli" /usr/local/bin/signal-cli \
 && rm /tmp/signal-cli.tar.gz
ENV JAVA_HOME=/opt/java
ENV PATH="/opt/java/bin:${PATH}"
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

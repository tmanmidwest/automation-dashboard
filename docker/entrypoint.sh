#!/bin/sh
set -e

cd /app/apps/server

# Fabric RDP session recordings are written by the guacd sidecar (which runs as a non-root
# user) into a named volume shared with this container. A fresh volume is root-owned, so guacd
# can't create files there ("Creation of recording failed: Permission denied"). This container
# runs as root and mounts the same volume, so make the shared dir writable by guacd regardless
# of its uid (sticky + world-writable, like /tmp). Best-effort — never block startup.
REC_DIR="${FABRIC_RECORDING_DIR:-/recordings}"
if [ -d "$REC_DIR" ]; then
  chmod 1777 "$REC_DIR" 2>/dev/null || echo "[cerebro] note: could not chmod $REC_DIR (recordings may fail to save)"
fi

echo "[cerebro] Applying database migrations..."
npx prisma migrate deploy

echo "[cerebro] Starting Cerebro server..."
# Built-in roles are seeded idempotently at startup (SeedService.onModuleInit).
exec node dist/main.js

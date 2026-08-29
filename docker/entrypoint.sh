#!/bin/sh
set -e

cd /app/apps/server

echo "[cerebro] Applying database migrations..."
npx prisma migrate deploy

echo "[cerebro] Starting Cerebro server..."
# Built-in roles are seeded idempotently at startup (SeedService.onModuleInit).
exec node dist/main.js

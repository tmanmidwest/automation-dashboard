-- Uptime monitoring: monitors, raw heartbeats, hourly rollups.
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "retryIntervalSec" INTEGER NOT NULL DEFAULT 60,
    "timeoutSec" INTEGER NOT NULL DEFAULT 10,
    "retries" INTEGER NOT NULL DEFAULT 1,
    "resendEveryN" INTEGER NOT NULL DEFAULT 0,
    "upsideDown" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "tags" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastChangeAt" TIMESTAMP(3),
    "lastCheckAt" TIMESTAMP(3),
    "lastLatencyMs" INTEGER,
    "lastMessage" TEXT,
    "certExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Monitor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MonitorHeartbeat" (
    "id" SERIAL NOT NULL,
    "monitorId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "message" TEXT,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitorHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MonitorRollup" (
    "id" SERIAL NOT NULL,
    "monitorId" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "total" INTEGER NOT NULL,
    "up" INTEGER NOT NULL,
    "down" INTEGER NOT NULL,
    "avgLatencyMs" INTEGER,
    "minLatencyMs" INTEGER,
    "maxLatencyMs" INTEGER,

    CONSTRAINT "MonitorRollup_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MonitorHeartbeat_monitorId_at_idx" ON "MonitorHeartbeat"("monitorId", "at");
CREATE INDEX "MonitorHeartbeat_monitorId_important_idx" ON "MonitorHeartbeat"("monitorId", "important");
CREATE INDEX "MonitorHeartbeat_at_idx" ON "MonitorHeartbeat"("at");
CREATE UNIQUE INDEX "MonitorRollup_monitorId_bucket_key" ON "MonitorRollup"("monitorId", "bucket");
CREATE INDEX "MonitorRollup_bucket_idx" ON "MonitorRollup"("bucket");

ALTER TABLE "MonitorHeartbeat" ADD CONSTRAINT "MonitorHeartbeat_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonitorRollup" ADD CONSTRAINT "MonitorRollup_monitorId_fkey" FOREIGN KEY ("monitorId") REFERENCES "Monitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

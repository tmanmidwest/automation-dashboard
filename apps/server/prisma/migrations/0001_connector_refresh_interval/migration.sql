-- Add per-connector background refresh interval (seconds).
ALTER TABLE "ConnectorInstance" ADD COLUMN "refreshIntervalSec" INTEGER NOT NULL DEFAULT 30;

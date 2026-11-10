-- Health monitoring (docs/health-monitoring.md): resource health reported by the
-- Cerebro agent — latest snapshot, raw samples, and 5m/1h rollups.
ALTER TABLE "Agent" ADD COLUMN "healthRole" TEXT;

CREATE TABLE "AgentHealth" (
    "agentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "sample" JSONB NOT NULL,
    "inventory" JSONB,
    "inventoryAt" TIMESTAMP(3),
    "autoRole" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AgentHealth_pkey" PRIMARY KEY ("agentId")
);

CREATE TABLE "AgentHealthSample" (
    "id" BIGSERIAL NOT NULL,
    "agentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "spanSec" INTEGER NOT NULL,
    "cpuPct" DOUBLE PRECISION,
    "cpuMaxPct" DOUBLE PRECISION,
    "memPct" DOUBLE PRECISION,
    "swapPct" DOUBLE PRECISION,
    "diskPct" DOUBLE PRECISION,
    "load1" DOUBLE PRECISION,
    "netRxBps" DOUBLE PRECISION,
    "netTxBps" DOUBLE PRECISION,
    "diskReadBps" DOUBLE PRECISION,
    "diskWriteBps" DOUBLE PRECISION,
    "disks" JSONB,
    CONSTRAINT "AgentHealthSample_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentHealthRollup" (
    "id" BIGSERIAL NOT NULL,
    "agentId" TEXT NOT NULL,
    "res" TEXT NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "samples" INTEGER NOT NULL,
    "onlineSec" INTEGER NOT NULL,
    "cpuAvg" DOUBLE PRECISION,
    "cpuMax" DOUBLE PRECISION,
    "memAvg" DOUBLE PRECISION,
    "memMax" DOUBLE PRECISION,
    "swapMax" DOUBLE PRECISION,
    "diskMax" DOUBLE PRECISION,
    "netRxAvg" DOUBLE PRECISION,
    "netTxAvg" DOUBLE PRECISION,
    "readAvg" DOUBLE PRECISION,
    "writeAvg" DOUBLE PRECISION,
    "disks" JSONB,
    CONSTRAINT "AgentHealthRollup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentHealthSample_agentId_at_key" ON "AgentHealthSample"("agentId", "at");
CREATE INDEX "AgentHealthSample_at_idx" ON "AgentHealthSample"("at");
CREATE UNIQUE INDEX "AgentHealthRollup_agentId_res_bucket_key" ON "AgentHealthRollup"("agentId", "res", "bucket");
CREATE INDEX "AgentHealthRollup_res_bucket_idx" ON "AgentHealthRollup"("res", "bucket");

ALTER TABLE "AgentHealth" ADD CONSTRAINT "AgentHealth_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentHealthSample" ADD CONSTRAINT "AgentHealthSample_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentHealthRollup" ADD CONSTRAINT "AgentHealthRollup_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

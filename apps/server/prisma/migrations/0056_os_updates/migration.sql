-- CreateTable
CREATE TABLE "AgentUpdateStatus" (
    "agentId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "manager" TEXT,
    "supported" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "note" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "security" INTEGER NOT NULL DEFAULT 0,
    "securityKnown" BOOLEAN NOT NULL DEFAULT false,
    "rebootRequired" BOOLEAN NOT NULL DEFAULT false,
    "rebootReason" TEXT,
    "rebootSince" TIMESTAMP(3),
    "securitySince" TIMESTAMP(3),
    "canInstall" BOOLEAN NOT NULL DEFAULT false,
    "proxmox" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'on',
    "installing" TEXT,
    "checking" BOOLEAN NOT NULL DEFAULT false,
    "packages" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentUpdateStatus_pkey" PRIMARY KEY ("agentId")
);

-- CreateTable
CREATE TABLE "AgentUpdateRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "scheduleId" TEXT,
    "batchId" TEXT,
    "ring" INTEGER,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "reboot" TEXT NOT NULL DEFAULT 'never',
    "snapshot" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "message" TEXT,
    "exitCode" INTEGER,
    "installed" INTEGER,
    "rebooting" BOOLEAN NOT NULL DEFAULT false,
    "snapshotName" TEXT,
    "snapshotNote" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "logLines" INTEGER NOT NULL DEFAULT 0,
    "requestedBy" TEXT,
    "pendingBefore" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentUpdateRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpdateSchedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "days" INTEGER[],
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "windowHours" INTEGER NOT NULL DEFAULT 4,
    "scope" TEXT NOT NULL DEFAULT 'security',
    "reboot" TEXT NOT NULL DEFAULT 'if-needed',
    "snapshot" BOOLEAN NOT NULL DEFAULT true,
    "rings" JSONB NOT NULL,
    "stopOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpdateSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentUpdateRun_agentId_createdAt_idx" ON "AgentUpdateRun"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentUpdateRun_status_idx" ON "AgentUpdateRun"("status");

-- CreateIndex
CREATE INDEX "AgentUpdateRun_scheduleId_idx" ON "AgentUpdateRun"("scheduleId");

-- CreateIndex
CREATE INDEX "AgentUpdateRun_batchId_idx" ON "AgentUpdateRun"("batchId");

-- AddForeignKey
ALTER TABLE "AgentUpdateStatus" ADD CONSTRAINT "AgentUpdateStatus_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentUpdateRun" ADD CONSTRAINT "AgentUpdateRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


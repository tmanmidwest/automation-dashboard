-- Stack backup & restore, Phase 1 (docs/stack-backup.md).
--
-- StackBackupTarget  a restic repository (B2 or S3-compatible). Credentials stay in
--                    the vault; only their keys are stored here.
-- StackBackupPolicy  what to capture for one compose stack on one Docker host, plus
--                    the (Phase 4) structured schedule. One row per stack, so a manual
--                    "back up now" and a scheduled run capture exactly the same thing.
-- StackBackupRun     one attempt: restic's summary counters plus the full run log.

CREATE TABLE "StackBackupTarget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'b2',
    "repository" TEXT NOT NULL,
    "passwordKey" TEXT NOT NULL,
    "credKey" TEXT NOT NULL,
    "hostCredKey" TEXT,
    "helperImage" TEXT NOT NULL DEFAULT 'restic/restic:latest',
    "keepLast" INTEGER,
    "keepDaily" INTEGER,
    "keepWeekly" INTEGER,
    "keepMonthly" INTEGER,
    "keepWithinDays" INTEGER,
    "lastStatus" TEXT NOT NULL DEFAULT 'never',
    "lastMessage" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StackBackupTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackBackupTarget_name_key" ON "StackBackupTarget"("name");

CREATE TABLE "StackBackupPolicy" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" TEXT NOT NULL DEFAULT 'off',
    "dayOfWeek" INTEGER NOT NULL DEFAULT 0,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "hour" INTEGER NOT NULL DEFAULT 3,
    "minute" INTEGER NOT NULL DEFAULT 0,
    "quiesce" TEXT NOT NULL DEFAULT 'hot',
    "transfer" TEXT NOT NULL DEFAULT 'direct',
    "secretMode" TEXT NOT NULL DEFAULT 'embed',
    "includeBinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" TEXT NOT NULL DEFAULT 'never',
    "lastMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StackBackupPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackBackupPolicy_connectorInstanceId_stackName_key" ON "StackBackupPolicy"("connectorInstanceId", "stackName");
CREATE INDEX "StackBackupPolicy_targetId_idx" ON "StackBackupPolicy"("targetId");

ALTER TABLE "StackBackupPolicy" ADD CONSTRAINT "StackBackupPolicy_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "StackBackupTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "StackBackupRun" (
    "id" TEXT NOT NULL,
    "policyId" TEXT,
    "connectorInstanceId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL,
    "snapshotId" TEXT,
    "bytesAdded" BIGINT,
    "bytesTotal" BIGINT,
    "filesNew" INTEGER,
    "filesTotal" INTEGER,
    "volumes" INTEGER NOT NULL DEFAULT 0,
    "binds" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "message" TEXT,
    "log" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StackBackupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StackBackupRun_policyId_startedAt_idx" ON "StackBackupRun"("policyId", "startedAt");
CREATE INDEX "StackBackupRun_connectorInstanceId_stackName_startedAt_idx" ON "StackBackupRun"("connectorInstanceId", "stackName", "startedAt");

ALTER TABLE "StackBackupRun" ADD CONSTRAINT "StackBackupRun_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "StackBackupPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

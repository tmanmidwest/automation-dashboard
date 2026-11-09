-- Stack backup sets + coverage (docs/stack-backup.md, "Backup sets").
--
-- StackBackupSet      shared settings for a group of stack backups, optionally scoped
--                     to one Docker host with auto-include of every stack on it.
-- StackCoverageEntry  every compose stack seen on a host — drives the coverage view and
--                     the "new stack with no backup" alert, and records "ignored on purpose".
-- StackBackupPolicy   gains setId + setOverrides (which settings it keeps for itself).

CREATE TABLE "StackBackupSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "connectorInstanceId" TEXT,
    "autoInclude" BOOLEAN NOT NULL DEFAULT false,
    "excludedStacks" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "excludes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StackBackupSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackBackupSet_name_key" ON "StackBackupSet"("name");
CREATE INDEX "StackBackupSet_targetId_idx" ON "StackBackupSet"("targetId");

ALTER TABLE "StackBackupSet" ADD CONSTRAINT "StackBackupSet_targetId_fkey"
    FOREIGN KEY ("targetId") REFERENCES "StackBackupTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StackBackupPolicy" ADD COLUMN "setId" TEXT;
ALTER TABLE "StackBackupPolicy" ADD COLUMN "setOverrides" TEXT[] DEFAULT ARRAY[]::TEXT[];
CREATE INDEX "StackBackupPolicy_setId_idx" ON "StackBackupPolicy"("setId");
ALTER TABLE "StackBackupPolicy" ADD CONSTRAINT "StackBackupPolicy_setId_fkey"
    FOREIGN KEY ("setId") REFERENCES "StackBackupSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "StackCoverageEntry" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "ignoreReason" TEXT,
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "StackCoverageEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackCoverageEntry_connectorInstanceId_stackName_key" ON "StackCoverageEntry"("connectorInstanceId", "stackName");

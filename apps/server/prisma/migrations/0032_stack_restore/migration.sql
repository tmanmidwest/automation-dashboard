-- Stack restore history (docs/stack-backup.md, Phase 3). Append-only: a restore
-- overwrites data, so the record of what went where outlives the policy and even
-- the destination host.

CREATE TABLE "StackRestoreRun" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sourceStackName" TEXT NOT NULL,
    "destInstanceId" TEXT NOT NULL,
    "destStackName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL,
    "message" TEXT,
    "volumes" INTEGER NOT NULL DEFAULT 0,
    "binds" INTEGER NOT NULL DEFAULT 0,
    "deployed" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER,
    "log" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StackRestoreRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StackRestoreRun_destInstanceId_startedAt_idx" ON "StackRestoreRun"("destInstanceId", "startedAt");
CREATE INDEX "StackRestoreRun_snapshotId_idx" ON "StackRestoreRun"("snapshotId");

-- Stack migrator: one row per "move a Compose stack between Docker hosts" attempt.
-- Append-only history (docs/stack-migrator.md).
CREATE TABLE "StackMigrationRun" (
    "id" TEXT NOT NULL,
    "sourceInstanceId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "destInstanceId" TEXT NOT NULL,
    "destStackName" TEXT NOT NULL,
    "repoTargetId" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'planned',
    "status" TEXT NOT NULL,
    "message" TEXT,
    "snapshotId" TEXT,
    "images" JSONB NOT NULL DEFAULT '[]',
    "sourceKept" BOOLEAN NOT NULL DEFAULT true,
    "durationMs" INTEGER,
    "log" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "StackMigrationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StackMigrationRun_destInstanceId_startedAt_idx" ON "StackMigrationRun"("destInstanceId", "startedAt");
CREATE INDEX "StackMigrationRun_sourceInstanceId_stackName_startedAt_idx" ON "StackMigrationRun"("sourceInstanceId", "stackName", "startedAt");

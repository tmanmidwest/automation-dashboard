-- Scheduled repository integrity check per backup target.
ALTER TABLE "StackBackupTarget" ADD COLUMN "integrityFrequency" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "StackBackupTarget" ADD COLUMN "integrityReadPercent" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "StackBackupTarget" ADD COLUMN "integrityStatus" TEXT NOT NULL DEFAULT 'never';
ALTER TABLE "StackBackupTarget" ADD COLUMN "integrityMessage" TEXT;
ALTER TABLE "StackBackupTarget" ADD COLUMN "integrityCheckedAt" TIMESTAMP(3);

-- Last scheduled test restore per stack.
ALTER TABLE "StackBackupPolicy" ADD COLUMN "verifyStatus" TEXT NOT NULL DEFAULT 'never';
ALTER TABLE "StackBackupPolicy" ADD COLUMN "verifyMessage" TEXT;
ALTER TABLE "StackBackupPolicy" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "StackBackupPolicy" ADD COLUMN "verifyRunId" TEXT;

-- Whole-host restore jobs.
CREATE TABLE "StackHostRestore" (
    "id" TEXT NOT NULL,
    "sourceInstanceId" TEXT NOT NULL,
    "sourceHostName" TEXT NOT NULL,
    "destInstanceId" TEXT NOT NULL,
    "destHostName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "message" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "StackHostRestore_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StackHostRestore_startedAt_idx" ON "StackHostRestore"("startedAt");

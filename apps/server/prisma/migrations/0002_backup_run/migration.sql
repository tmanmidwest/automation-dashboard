-- Durable history of connector scheduled syncs (e.g. Backblaze NAS→B2 push).
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" TEXT NOT NULL,
    "message" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupRun_connectorInstanceId_startedAt_idx" ON "BackupRun"("connectorInstanceId", "startedAt");

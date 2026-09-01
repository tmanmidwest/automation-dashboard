-- Per-channel notification delivery history (the notifications "History" view).
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "alertKey" TEXT,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "source" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "connectorId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_channel_idx" ON "NotificationLog"("channel");

-- CreateIndex
CREATE INDEX "NotificationLog_status_idx" ON "NotificationLog"("status");

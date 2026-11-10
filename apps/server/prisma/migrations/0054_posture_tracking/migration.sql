-- Posture page (docs/posture.md): remember when each finding and affected item was first
-- seen and fixed, per-item snooze / accepted risk, and a history of what happened.
CREATE TABLE "PostureFindingRecord" (
    "id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "PostureFindingRecord_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PostureFindingRecord_resolvedAt_idx" ON "PostureFindingRecord"("resolvedAt");

CREATE TABLE "PostureItemRecord" (
    "findingId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "goneAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'open',
    "until" TIMESTAMP(3),
    "note" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3),
    "acceptedSeverity" TEXT,
    CONSTRAINT "PostureItemRecord_pkey" PRIMARY KEY ("findingId", "label")
);
ALTER TABLE "PostureItemRecord" ADD CONSTRAINT "PostureItemRecord_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "PostureFindingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PostureEvent" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "actor" TEXT,
    CONSTRAINT "PostureEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PostureEvent_findingId_at_idx" ON "PostureEvent"("findingId", "at");
ALTER TABLE "PostureEvent" ADD CONSTRAINT "PostureEvent_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "PostureFindingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

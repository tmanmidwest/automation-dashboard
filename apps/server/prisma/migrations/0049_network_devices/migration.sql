-- New-device detection: every UniFi client seen, by MAC (docs/architecture-map.md).
CREATE TABLE "NetworkDevice" (
    "mac" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "name" TEXT,
    "vendor" TEXT,
    "ip" TEXT,
    "network" TEXT,
    "via" TEXT,
    "privateMac" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'new',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "NetworkDevice_pkey" PRIMARY KEY ("mac")
);

CREATE INDEX "NetworkDevice_status_idx" ON "NetworkDevice"("status");

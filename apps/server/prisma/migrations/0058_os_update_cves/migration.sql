-- OS update severity and CVEs: per-machine priority summary, plus caches for OSV.dev
-- lookups, advisory records and per-CVE scores (CVSS / EPSS).
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "distro" JSONB;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "priority" TEXT;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "cveCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "kevCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "kevCves" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "patchNowSince" TIMESTAMP(3);
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "restartPriority" TEXT;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "enrichedAt" TIMESTAMP(3);
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "enrichNote" TEXT;

CREATE TABLE "OsVulnLookup" (
    "id" TEXT NOT NULL,
    "ecosystem" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "vulnIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsVulnLookup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OsVulnLookup_ecosystem_name_version_key" ON "OsVulnLookup"("ecosystem", "name", "version");

CREATE TABLE "OsAdvisory" (
    "id" TEXT NOT NULL,
    "cves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT,
    "cvss" DOUBLE PRECISION,
    "cvssVector" TEXT,
    "priority" TEXT,
    "published" TIMESTAMP(3),
    "missing" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OsAdvisory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OsCve" (
    "id" TEXT NOT NULL,
    "cvss" DOUBLE PRECISION,
    "cvssVector" TEXT,
    "priority" TEXT,
    "summary" TEXT,
    "scoredAt" TIMESTAMP(3),
    "epss" DOUBLE PRECISION,
    "epssPercentile" DOUBLE PRECISION,
    "epssAt" TIMESTAMP(3),
    CONSTRAINT "OsCve_pkey" PRIMARY KEY ("id")
);

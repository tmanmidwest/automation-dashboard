-- Docker connector: per-deploy snapshots of a managed stack's compose + env,
-- so a stack can be rolled back to a previous version. See docs/connectors/docker.md.
CREATE TABLE "DockerStackRevision" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "compose" TEXT NOT NULL,
    "env" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DockerStackRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DockerStackRevision_connectorInstanceId_name_createdAt_idx" ON "DockerStackRevision"("connectorInstanceId", "name", "createdAt");

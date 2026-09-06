-- Docker connector Phase 5: Cerebro-managed compose stacks. Cerebro stores the
-- compose file; deploys run via SSH `docker compose`. See docs/connectors/docker.md.
CREATE TABLE "DockerStack" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "compose" TEXT NOT NULL,
    "lastStatus" TEXT NOT NULL DEFAULT 'never',
    "lastMessage" TEXT,
    "lastDeployedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DockerStack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DockerStack_connectorInstanceId_name_key" ON "DockerStack"("connectorInstanceId", "name");

CREATE INDEX "DockerStack_connectorInstanceId_idx" ON "DockerStack"("connectorInstanceId");

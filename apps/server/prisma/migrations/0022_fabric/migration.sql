-- Fabric — agent-brokered remote access (RDP / SSH). Phase 1: control plane.
-- See docs/fabric-remote-access.md.

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "agentVersion" TEXT,
    "tags" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "enrollHash" TEXT,
    "enrollExpires" TIMESTAMP(3),
    "credPrefix" TEXT,
    "credHash" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTarget" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '127.0.0.1',
    "port" INTEGER NOT NULL,
    "label" TEXT,
    "secretRef" TEXT,

    CONSTRAINT "AgentTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FabricSession" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "bytesUp" BIGINT NOT NULL DEFAULT 0,
    "bytesDown" BIGINT NOT NULL DEFAULT 0,
    "recordPath" TEXT,

    CONSTRAINT "FabricSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_enrollHash_key" ON "Agent"("enrollHash");
CREATE UNIQUE INDEX "Agent_credPrefix_key" ON "Agent"("credPrefix");
CREATE INDEX "AgentTarget_agentId_idx" ON "AgentTarget"("agentId");
CREATE UNIQUE INDEX "AgentTarget_agentId_kind_host_port_key" ON "AgentTarget"("agentId", "kind", "host", "port");
CREATE INDEX "FabricSession_agentId_startedAt_idx" ON "FabricSession"("agentId", "startedAt");

-- AddForeignKey
ALTER TABLE "AgentTarget" ADD CONSTRAINT "AgentTarget_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FabricSession" ADD CONSTRAINT "FabricSession_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

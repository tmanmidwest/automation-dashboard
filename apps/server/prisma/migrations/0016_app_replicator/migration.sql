-- App Replicator: register a Git-repo app once, deploy it as many isolated
-- instances onto a Docker host. See docs/app-replicator.md.

-- Catalog entry (a reusable app template).
CREATE TABLE "ReplicatorApp" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gitUrl" TEXT NOT NULL,
    "gitRef" TEXT NOT NULL DEFAULT 'main',
    "gitPath" TEXT,
    "gitCredKey" TEXT,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "usesGeneratedCompose" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplicatorApp_pkey" PRIMARY KEY ("id")
);

-- One deployed instance of an app. The low-level compose stack lives in
-- DockerStack (owned by the Docker connector); this is the higher-level record.
CREATE TABLE "ReplicatorDeployment" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "dockerInstanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "project" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "secretVars" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ports" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastMessage" TEXT,
    "deployedCommit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplicatorDeployment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReplicatorDeployment_appId_idx" ON "ReplicatorDeployment"("appId");
CREATE INDEX "ReplicatorDeployment_dockerInstanceId_idx" ON "ReplicatorDeployment"("dockerInstanceId");

ALTER TABLE "ReplicatorDeployment"
    ADD CONSTRAINT "ReplicatorDeployment_appId_fkey"
    FOREIGN KEY ("appId") REFERENCES "ReplicatorApp"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- App Replicator Phase 2: ingress routes exposing a deployment's published port
-- via a Cloudflare tunnel route or an Nginx Proxy Manager proxy host.
-- See docs/app-replicator.md.

CREATE TABLE "ReplicatorIngress" (
    "id" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "hostPort" INTEGER NOT NULL,
    "hostname" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplicatorIngress_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReplicatorIngress_deploymentId_idx" ON "ReplicatorIngress"("deploymentId");

ALTER TABLE "ReplicatorIngress"
    ADD CONSTRAINT "ReplicatorIngress_deploymentId_fkey"
    FOREIGN KEY ("deploymentId") REFERENCES "ReplicatorDeployment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

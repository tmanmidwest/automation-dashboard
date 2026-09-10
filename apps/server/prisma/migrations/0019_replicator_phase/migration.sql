-- App Replicator: async deploys — a live sub-step ("phase") shown on the row
-- while a deploy/redeploy runs in the background. See docs/app-replicator.md.

ALTER TABLE "ReplicatorDeployment" ADD COLUMN "phase" TEXT;

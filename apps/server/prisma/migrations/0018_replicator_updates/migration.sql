-- App Replicator Phase 3: track when a deployment's repo has moved ahead of its
-- deployed commit, so the UI can flag "update available" and Automations can act.
-- See docs/app-replicator.md.

ALTER TABLE "ReplicatorDeployment"
    ADD COLUMN "updateAvailable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "availableCommit" TEXT;

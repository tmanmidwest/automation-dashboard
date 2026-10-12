-- Stack migrator: re-point an App Replicator deployment when its stack is migrated,
-- instead of orphaning the replicator row. See docs/stack-migrator.md.
ALTER TABLE "StackMigrationRun" ADD COLUMN "replicatorDeploymentId" TEXT;
ALTER TABLE "StackMigrationRun" ADD COLUMN "replicatorRepointed" BOOLEAN NOT NULL DEFAULT false;

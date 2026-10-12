-- Store the migrator port remap so cutover can sync a re-pointed replicator deployment.
ALTER TABLE "StackMigrationRun" ADD COLUMN "portMap" JSONB;

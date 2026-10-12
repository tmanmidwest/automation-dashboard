-- Soft-archive (dismiss) terminal stack-migration runs so they drop out of the default list.
ALTER TABLE "StackMigrationRun" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Restore safety copies (docs/stack-backup.md, "Undoing a restore"): before a restore
-- overwrites existing volumes or bind paths, it snapshots them; this records which
-- snapshot holds that undo point.
ALTER TABLE "StackRestoreRun" ADD COLUMN "safetySnapshotId" TEXT;

-- Stack backup pre/post hooks (docs/stack-backup.md, Phase 5). Commands run in
-- the stack's own containers around the capture — typically a database dump, so
-- a live database can be backed up consistently without stopping the stack.

ALTER TABLE "StackBackupPolicy" ADD COLUMN "preHooks" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "StackBackupPolicy" ADD COLUMN "postHooks" JSONB NOT NULL DEFAULT '[]';

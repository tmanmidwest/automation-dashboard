-- App Replicator: an app can be registered from a pasted compose file instead of
-- a Git repo (typically one that runs prebuilt images). The pasted text is stored
-- on the app and deployed as a plain compose stack; such apps have no repo, so
-- gitUrl becomes optional. See docs/app-replicator.md.

ALTER TABLE "ReplicatorApp"
    ADD COLUMN "compose" TEXT,
    ALTER COLUMN "gitUrl" DROP NOT NULL;

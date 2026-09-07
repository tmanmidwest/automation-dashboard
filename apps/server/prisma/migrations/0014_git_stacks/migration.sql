-- Git-source stacks + vault "Git credential" secret kind (Docker connector Phase 6).

-- Secrets can now describe their value shape: 'generic' (single value) or 'git' (JSON {host,username,secret}).
ALTER TABLE "SecretMeta" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'generic';

-- A stack can be sourced from stored compose or a git repo.
ALTER TABLE "DockerStack" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'compose';
ALTER TABLE "DockerStack" ADD COLUMN "gitUrl" TEXT;
ALTER TABLE "DockerStack" ADD COLUMN "gitRef" TEXT;
ALTER TABLE "DockerStack" ADD COLUMN "gitPath" TEXT;
ALTER TABLE "DockerStack" ADD COLUMN "gitCredKey" TEXT;

-- Revisions snapshot the git source + deployed commit so a git stack can roll back exactly.
ALTER TABLE "DockerStackRevision" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'compose';
ALTER TABLE "DockerStackRevision" ADD COLUMN "gitUrl" TEXT;
ALTER TABLE "DockerStackRevision" ADD COLUMN "gitRef" TEXT;
ALTER TABLE "DockerStackRevision" ADD COLUMN "gitPath" TEXT;
ALTER TABLE "DockerStackRevision" ADD COLUMN "commit" TEXT;

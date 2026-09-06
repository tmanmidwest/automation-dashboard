-- Docker connector: store a stack's optional `.env` file contents (written beside
-- the compose on deploy for ${VAR} interpolation). See docs/connectors/docker.md.
ALTER TABLE "DockerStack" ADD COLUMN "env" TEXT;

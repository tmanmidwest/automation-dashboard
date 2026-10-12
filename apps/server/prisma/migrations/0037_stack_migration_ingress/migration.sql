-- Stack migrator P2: automated-cutover ingress on a migration run.
-- `ingress` holds the CF/NPM connector + hostname + port to flip source→target;
-- `ingressFlipped` records that the repoint has happened. See docs/stack-migrator.md.
ALTER TABLE "StackMigrationRun" ADD COLUMN "ingress" JSONB;
ALTER TABLE "StackMigrationRun" ADD COLUMN "ingressFlipped" BOOLEAN NOT NULL DEFAULT false;

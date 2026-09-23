-- App Replicator: per-deployment environment extras. Some apps read a key that
-- neither the compose file nor any committed env file mentions, and some keys
-- differ per instance rather than per app — those can't live on the shared
-- ReplicatorApp schema. `extraEnv` holds the non-secret ones ({ NAME: value });
-- `extraSecretVars` names the ones whose values live in the vault, under the same
-- `deployment:<id>:<name>` keys as `secretVars`, so teardown cleans both up the
-- same way. See docs/app-replicator.md.

ALTER TABLE "ReplicatorDeployment" ADD COLUMN "extraEnv" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "ReplicatorDeployment" ADD COLUMN "extraSecretVars" TEXT[] DEFAULT ARRAY[]::TEXT[];

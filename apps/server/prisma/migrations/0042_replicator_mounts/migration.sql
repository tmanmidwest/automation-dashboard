-- App Replicator: per-deployment volume mounts (bind / named), layered on via a
-- generated docker-compose.override.yml at deploy time. Docker target only.
ALTER TABLE "ReplicatorDeployment" ADD COLUMN "extraMounts" JSONB NOT NULL DEFAULT '[]';

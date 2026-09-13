-- App Replicator: second deploy target (AWS ECS/Fargate) alongside Docker.
-- `targetKind` distinguishes the backend (existing rows are all Docker); `ecs`
-- holds the Fargate teardown handles (EcsDeploymentRefs) as JSON, null for Docker.
-- See docs/app-replicator-ecs-target.md.

ALTER TABLE "ReplicatorDeployment" ADD COLUMN "targetKind" TEXT NOT NULL DEFAULT 'docker';
ALTER TABLE "ReplicatorDeployment" ADD COLUMN "ecs" JSONB;

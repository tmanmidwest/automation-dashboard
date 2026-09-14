-- App Replicator ECS/ALB ingress: an ALB host-header rule + a Cloudflare DNS
-- record need more teardown handles than the single `ref` column holds. `meta`
-- carries the ALB listener-rule ARN + the AWS connector that owns it (JSON);
-- null for CF-tunnel / NPM ingress. See docs/app-replicator-ecs-target.md.

ALTER TABLE "ReplicatorIngress" ADD COLUMN "meta" JSONB;

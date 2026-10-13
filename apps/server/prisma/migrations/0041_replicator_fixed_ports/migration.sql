-- App Replicator: reachable ports that aren't backed by an adjustable ${VAR} —
-- literal `ports:` mappings, port ranges, host-network bindings, and ports the
-- operator added by hand. The compose introspector only modeled parameterized
-- ports (`${APP_PORT:-8080}:80`) as variables, so a repo with a hardcoded
-- `8123:8123` (or `network_mode: host`) registered with nothing to expose and
-- ingress couldn't be set up. Stored as ReplicatorFixedPort[] JSON, read at
-- deploy time alongside the variable schema. See docs/app-replicator.md.

ALTER TABLE "ReplicatorApp" ADD COLUMN "fixedPorts" JSONB NOT NULL DEFAULT '[]';

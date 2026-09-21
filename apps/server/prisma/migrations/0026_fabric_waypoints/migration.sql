-- Fabric Waypoints (network-gateway session connectors). See docs/fabric-waypoints.md.

-- Agent gains a mode: "endpoint" (today) or "waypoint" (a LAN gateway/bastion).
ALTER TABLE "Agent" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'endpoint';
ALTER TABLE "Agent" ADD COLUMN "egressCidrs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- AgentTarget becomes the Jump Item: curated LAN targets + (Phase 3) web jumps.
ALTER TABLE "AgentTarget" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'discovered';
ALTER TABLE "AgentTarget" ADD COLUMN "group" TEXT;
ALTER TABLE "AgentTarget" ADD COLUMN "webUrl" TEXT;

-- Audit the resolved target host behind a Waypoint, not just the brokering agent.
ALTER TABLE "FabricSession" ADD COLUMN "targetHost" TEXT;
ALTER TABLE "FabricSession" ADD COLUMN "targetPort" INTEGER;
ALTER TABLE "FabricSession" ADD COLUMN "targetLabel" TEXT;

-- Fabric per-session approval gate (four-eyes). See docs/fabric-waypoints.md.
-- When set, a session through this agent must be approved by a fabric:approve user
-- before it opens. Approval requests themselves live in memory (short-lived), so
-- there is no table — only this per-agent toggle.
ALTER TABLE "Agent" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;

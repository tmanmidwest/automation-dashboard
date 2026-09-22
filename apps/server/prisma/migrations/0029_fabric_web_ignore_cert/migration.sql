-- Per-route "ignore TLS certificate errors" for Remote Browser web routes, so a
-- self-signed internal target can be reached without weakening TLS validation for
-- other sessions (replaces the global setting). See docs/fabric-waypoints.md.
ALTER TABLE "AgentTarget" ADD COLUMN "webIgnoreCertErrors" BOOLEAN NOT NULL DEFAULT false;

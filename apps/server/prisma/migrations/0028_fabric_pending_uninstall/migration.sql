-- Tombstone a deleted agent/Waypoint until it self-uninstalls + acks (or is
-- force-removed). See docs/fabric-waypoints.md.
ALTER TABLE "Agent" ADD COLUMN "pendingUninstallAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "pendingUninstallBy" TEXT;

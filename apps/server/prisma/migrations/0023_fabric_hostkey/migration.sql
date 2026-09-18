-- Fabric Phase 4b: pin SSH host keys (trust-on-first-use). See docs/fabric-remote-access.md.
ALTER TABLE "AgentTarget" ADD COLUMN "hostKey" TEXT;

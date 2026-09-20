-- Track when an agent's host last installed + validated the SSH CA trust.
ALTER TABLE "Agent" ADD COLUMN "caTrustedAt" TIMESTAMP(3);

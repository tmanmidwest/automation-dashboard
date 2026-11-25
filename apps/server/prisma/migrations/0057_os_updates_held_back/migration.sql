-- Held-back apt packages (only a full upgrade installs them) and what that full upgrade would remove.
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "heldBack" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AgentUpdateStatus" ADD COLUMN "fullUpgradeRemoves" TEXT[] DEFAULT ARRAY[]::TEXT[];

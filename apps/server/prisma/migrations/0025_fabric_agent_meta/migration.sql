-- Local IP (reported by the agent) + a free-form operator note.
ALTER TABLE "Agent" ADD COLUMN "localIp" TEXT;
ALTER TABLE "Agent" ADD COLUMN "notes" TEXT;

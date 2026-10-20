-- Saviynt Zuma agent registry (docs/assistant-computer.md): per-agent governance details and
-- the agent's registration/sync state.
ALTER TABLE "AssistantAgent" ADD COLUMN "governance" JSONB,
ADD COLUMN "zumaAgentId" TEXT,
ADD COLUMN "zumaStatus" TEXT,
ADD COLUMN "zumaSyncedAt" TIMESTAMP(3),
ADD COLUMN "zumaLastError" TEXT,
ADD COLUMN "zumaPayloadHash" TEXT,
ADD COLUMN "zumaExtrasHash" TEXT;

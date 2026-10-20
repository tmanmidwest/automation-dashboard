-- External MCP servers as a Computer tool source (docs/assistant-computer.md). Credentials live
-- in the vault; `tools` is the pinned tool list from the last refresh.
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "url" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'none',
    "authHeader" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "toolsRefreshedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AssistantAgent" ADD COLUMN "mcpServerIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

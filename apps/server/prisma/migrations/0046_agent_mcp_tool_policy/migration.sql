-- Per-agent MCP tool policy (docs/assistant-computer.md): tools switched off, and tools that
-- skip the approval prompt. Keys are `<serverId>:<toolName>`.
ALTER TABLE "AssistantAgent" ADD COLUMN "mcpDisabledTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "mcpAutoApproveTools" TEXT[] DEFAULT ARRAY[]::TEXT[];

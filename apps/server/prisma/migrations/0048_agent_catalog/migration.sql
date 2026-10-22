-- External read-only agent catalog (docs/assistant-computer.md): per-agent opt-out and a
-- revision counter, plus machine (client_credentials) OAuth clients.
ALTER TABLE "AssistantAgent" ADD COLUMN "catalogHidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "OAuthClient" ADD COLUMN "allowedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "lastUsedAt" TIMESTAMP(3),
ADD COLUMN "secretRotatedAt" TIMESTAMP(3);

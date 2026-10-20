-- Computer agent profiles (docs/assistant-computer.md). The default agent row is seeded on
-- boot from the legacy `assistant.config` setting, so nothing is migrated here.
CREATE TABLE "AssistantAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "backend" TEXT NOT NULL DEFAULT 'ollama',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "instructions" TEXT,
    "contextPrimer" BOOLEAN NOT NULL DEFAULT true,
    "maxRounds" INTEGER NOT NULL DEFAULT 6,
    "toolMode" TEXT NOT NULL DEFAULT 'all',
    "tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantAgent_pkey" PRIMARY KEY ("id")
);

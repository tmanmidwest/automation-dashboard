-- Automations engine: rules (when → if → do) + run history. See docs/automations.md.
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" JSONB NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "cooldownSec" INTEGER NOT NULL DEFAULT 60,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutomationRun_ruleId_createdAt_idx" ON "AutomationRun"("ruleId", "createdAt");

CREATE INDEX "AutomationRun_createdAt_idx" ON "AutomationRun"("createdAt");

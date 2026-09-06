-- Secrets vault: management metadata sidecar for the encrypted Secret store.
-- 1:1 with Secret by key. Holds no secret material — see docs/secrets-vault.md.
CREATE TABLE "SecretMeta" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'manual',
    "owningConnectorId" TEXT,
    "rotateAfterDays" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretMeta_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "SecretMeta_category_idx" ON "SecretMeta"("category");

CREATE INDEX "SecretMeta_owningConnectorId_idx" ON "SecretMeta"("owningConnectorId");

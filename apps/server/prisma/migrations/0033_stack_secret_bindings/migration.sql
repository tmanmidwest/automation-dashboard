-- Stack secret bindings (docs/stack-backup.md, Phase 2): which vault key backs
-- which of a stack's environment variables. Merged from what the App Replicator
-- stored, what a keyed value-digest match infers, and what an operator declares
-- — so a restore knows what it can re-materialize from the vault and what exists
-- only inside the snapshot.

CREATE TABLE "StackSecretBinding" (
    "id" TEXT NOT NULL,
    "connectorInstanceId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "varName" TEXT NOT NULL,
    "vaultKey" TEXT,
    "origin" TEXT NOT NULL,
    "valueDigest" TEXT,
    "secretish" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StackSecretBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StackSecretBinding_connectorInstanceId_stackName_varName_key" ON "StackSecretBinding"("connectorInstanceId", "stackName", "varName");
CREATE INDEX "StackSecretBinding_connectorInstanceId_stackName_idx" ON "StackSecretBinding"("connectorInstanceId", "stackName");
CREATE INDEX "StackSecretBinding_vaultKey_idx" ON "StackSecretBinding"("vaultKey");

-- Per-user key/value UI preferences (server-side, so they sync across devices).
-- Value is arbitrary JSON (the dashboard layout, etc.). One row per (user, key).
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserPreference_userId_key_key" ON "UserPreference"("userId", "key");

ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

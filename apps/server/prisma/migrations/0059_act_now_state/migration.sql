-- Act Now worklist: update and backup items snoozed from the list (docs/act-now.md).
CREATE TABLE "ActNowState" (
    "key" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "setBy" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tier" INTEGER NOT NULL,
    "kevCves" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "ActNowState_pkey" PRIMARY KEY ("key")
);

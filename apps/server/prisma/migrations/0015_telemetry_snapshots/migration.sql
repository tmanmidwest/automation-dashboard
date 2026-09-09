-- Persisted last-known-good telemetry so the dashboard + Docker Fleet render instantly on
-- login / after a redeploy instead of waiting on a cold network fan-out.
-- See docs/dashboard-telemetry-snapshots.md.

-- Per-connector dashboard telemetry (metrics + guests), cascaded on connector delete.
CREATE TABLE "ConnectorTelemetrySnapshot" (
    "instanceId" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "guests" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectorTelemetrySnapshot_pkey" PRIMARY KEY ("instanceId")
);

ALTER TABLE "ConnectorTelemetrySnapshot"
    ADD CONSTRAINT "ConnectorTelemetrySnapshot_instanceId_fkey"
    FOREIGN KEY ("instanceId") REFERENCES "ConnectorInstance"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Single-row cache (id = 'singleton') of the aggregated Docker Fleet tree.
CREATE TABLE "DockerFleetSnapshot" (
    "id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DockerFleetSnapshot_pkey" PRIMARY KEY ("id")
);

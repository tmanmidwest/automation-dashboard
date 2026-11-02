-- Device types for network clients (docs/architecture-map.md#device-types).
ALTER TABLE "NetworkDevice" ADD COLUMN "deviceType" TEXT;
ALTER TABLE "NetworkDevice" ADD COLUMN "typeOverride" TEXT;

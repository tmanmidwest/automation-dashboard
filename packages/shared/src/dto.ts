/** Shared DTOs used across the API boundary. */

import type { Permission } from './rbac';
import type { OverviewMetric } from './connector';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  roleSlug: string;
  roleName: string;
  permissions: Permission[];
  /** How this user authenticated. */
  authProvider: 'local' | 'oidc';
}

export interface FirstRunStatus {
  /** True until the initial admin account has been created. */
  needsSetup: boolean;
}

export interface VersionInfo {
  version: string;
  gitSha: string;
  builtAt?: string;
}

/** Provider info exposed publicly on the login screen (no secrets, enabled only). */
export interface PublicIdentityProvider {
  slug: string;
  label: string;
  buttonLabel: string;
  icon: string;
}

/** Full provider config for the admin Authentication screen (never includes the secret). */
export interface IdentityProviderConfig {
  id: string;
  slug: string;
  label: string;
  type: 'oidc';
  issuer: string;
  clientId: string;
  buttonLabel: string;
  icon: string;
  scopes: string;
  enabled: boolean;
  autoCreateUsers: boolean;
  defaultRoleSlug: string;
  allowedDomains: string[];
  sortOrder: number;
  /** Whether a client secret is stored (so the UI can show "saved"). */
  clientSecretSet: boolean;
  /** The exact redirect URI to register at the provider. */
  redirectUri: string;
}

/** An installed connector instance as listed in the UI (no secrets). */
export interface ConnectorInstanceSummary {
  id: string;
  connectorId: string;
  connectorName: string;
  icon: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  /** ISO timestamp of the last successful data fetch from this connector, or null if it hasn't synced yet. */
  lastSyncedAt: string | null;
  /** How often (seconds) background telemetry re-queries this connector's external system. */
  refreshIntervalSec: number;
}

/** Full instance config for the edit screen — non-secret values plus which secrets are set. */
export interface ConnectorInstanceConfig extends ConnectorInstanceSummary {
  config: Record<string, unknown>;
  /** Keyed by secret field → whether a value is stored. */
  secretFieldsSet: Record<string, boolean>;
}

/** Status of an async connector operation job (polled by the UI). */
export interface ConnectorJobStatus {
  id: string;
  label: string;
  status: 'running' | 'success' | 'error';
  /** Human-readable progress lines, newest last. */
  steps: string[];
  message?: string;
  createdResourceId?: string;
  /** ISO start time — lets the UI show elapsed time in the running-operation banner. */
  startedAt?: string;
}

export interface OverviewGuest {
  name: string;
  kind: string;
  status: string;
  node: string;
  connector: string;
}

export interface OverviewSource {
  name: string;
  ok: boolean;
  message?: string;
}

/** Aggregated dashboard telemetry across all connectors. */
export interface DashboardOverview {
  connectors: { total: number; ok: number };
  /** Per-connector reachability, for surfacing issues on the dashboard. */
  sources: OverviewSource[];
  metrics: OverviewMetric[];
  guests: OverviewGuest[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppLogEntry {
  id: string;
  level: LogLevel;
  context: string;
  message: string;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
  meta?: Record<string, unknown>;
  createdAt: string;
}

/** An API token as returned to its owner (never includes the secret). */
export interface ApiTokenSummary {
  id: string;
  name: string;
  /** Public prefix segment, shown so the owner can recognize a token (e.g. "k3f9x2a1"). */
  prefix: string;
  scopes: Permission[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Returned once, immediately after minting: the full plaintext token to copy. */
export interface ApiTokenCreated {
  token: ApiTokenSummary;
  /** The full `cbro_<prefix>_<secret>` string — shown once and never retrievable again. */
  secret: string;
}

/** An OAuth client as shown to an admin (never includes the secret). */
export interface OAuthClientSummary {
  id: string;
  clientId: string;
  name: string;
  type: 'public' | 'confidential';
  redirectUris: string[];
  disabled: boolean;
  /** True for confidential clients that have a secret stored. */
  clientSecretSet: boolean;
  createdAt: string;
}

/** Returned once at creation: the client plus, for confidential clients, its plaintext secret. */
export interface OAuthClientCreated {
  client: OAuthClientSummary;
  /** The client secret — shown once, only for confidential clients. */
  clientSecret?: string;
}

/** A user's remembered authorization of an OAuth client (for the "authorized apps" view). */
export interface OAuthGrantSummary {
  clientId: string;
  clientName: string;
  scopes: Permission[];
  createdAt: string;
  /** Count of the user's currently-active (non-revoked, unexpired) refresh tokens for this client. */
  activeTokenCount: number;
}

/** One camera tile on the Viewscreen: a connector instance + entity, with how to render it. */
export interface ViewscreenCamera {
  /** Stable client-generated id for this tile (so tiles can be reordered/edited). */
  id: string;
  /** The connector instance the camera lives on (e.g. a Home Assistant instance). */
  instanceId: string;
  /** The connector's resource id for the camera (e.g. an HA entity id like camera.front_door). */
  entityId: string;
  /** Display name shown on the tile. */
  name: string;
  /**
   * Default behavior when the tile loads:
   *  - 'mjpeg'    — live motion-JPEG stream, starts immediately
   *  - 'snapshot' — a still that refreshes every few seconds, starts immediately
   *  - 'manual'   — nothing loads until you press "Go Live" (for solar/battery cameras)
   * A tile can always be started or stopped on demand regardless of this default.
   */
  mode: 'mjpeg' | 'snapshot' | 'manual';
}

/** The persisted Viewscreen layout (global; stored under the `viewscreen.cameras` setting). */
export interface ViewscreenConfig {
  cameras: ViewscreenCamera[];
  /** Grid columns on wide screens (1–6). */
  columns?: number;
}

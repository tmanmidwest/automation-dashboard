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

/** Shared DTOs used across the API boundary. */

import type { Permission } from './rbac';

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

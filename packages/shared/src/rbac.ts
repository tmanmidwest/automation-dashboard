/**
 * Role-based access control primitives.
 *
 * Phase 1 ships two built-in roles — Viewer and Admin — but permissions are
 * modeled as data (a list of permission strings per role) so we can add
 * granular, per-connector roles later without a schema change.
 */

/** Every discrete capability in the system. Add to this union as features land. */
export type Permission =
  // Platform administration
  | 'settings:read'
  | 'settings:write'
  | 'users:read'
  | 'users:write'
  | 'logs:read'
  | 'audit:read'
  // Connectors (extension host)
  | 'connectors:read'
  | 'connectors:write' // install / configure / enable
  | 'connectors:action'; // perform managing actions (start/stop VM, etc.)

/** The two built-in roles requested for launch: View Only and Full Control. */
export const BUILTIN_ROLES = {
  viewer: {
    name: 'Viewer',
    slug: 'viewer',
    description: 'Read-only access to everything.',
    permissions: [
      'settings:read',
      'users:read',
      'logs:read',
      'audit:read',
      'connectors:read',
    ] as Permission[],
  },
  admin: {
    name: 'Administrator',
    slug: 'admin',
    description: 'Full control of Cerebro and all connectors.',
    permissions: [
      'settings:read',
      'settings:write',
      'users:read',
      'users:write',
      'logs:read',
      'audit:read',
      'connectors:read',
      'connectors:write',
      'connectors:action',
    ] as Permission[],
  },
} as const;

export type BuiltinRoleSlug = keyof typeof BUILTIN_ROLES;

export function hasPermission(
  granted: readonly Permission[] | undefined,
  required: Permission,
): boolean {
  return !!granted && granted.includes(required);
}

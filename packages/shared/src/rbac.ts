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
  // Secrets vault (session-only; never a bearer-token scope)
  | 'secrets:read' // list vault metadata
  | 'secrets:write' // set / rotate / delete secrets
  // Automations (rules engine; session-only — a rule can run infra actions)
  | 'automations:read'
  | 'automations:write'
  // App Replicator (deploy apps from Git; session-only — deploying runs infra)
  | 'replicator:read'
  | 'replicator:write'
  // Connectors (extension host)
  | 'connectors:read'
  | 'connectors:write' // install / configure / enable
  | 'connectors:action' // perform managing actions (start/stop VM, etc.)
  // Uptime monitors
  | 'monitors:read'
  | 'monitors:write' // add / edit / pause / delete monitors
  // Notifications (send an ad-hoc alert through the configured channels)
  | 'notifications:send'
  // Fabric — agent-brokered remote access (session-only; brokers interactive RDP/SSH)
  | 'fabric:read' // list agents / sessions
  | 'fabric:connect' // open an RDP/SSH session to an agent
  | 'fabric:manage' // enroll / revoke agents, edit targets
  | 'fabric:approve' // approve/deny four-eyes session requests
  // The Computer — in-app LLM assistant (session-only; runs tools as the user)
  | 'assistant:use';

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
      'monitors:read',
      'replicator:read',
      'fabric:read',
      'assistant:use',
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
      'monitors:read',
      'monitors:write',
      'notifications:send',
      'secrets:read',
      'secrets:write',
      'automations:read',
      'automations:write',
      'replicator:read',
      'replicator:write',
      'fabric:read',
      'fabric:connect',
      'fabric:manage',
      'fabric:approve',
      'assistant:use',
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

/**
 * The permissions that may be granted to a programmatic credential (API token / OAuth
 * access token) for the API + MCP server. A superset of the read scopes plus the two write
 * capabilities we expose to automation. Deliberately excludes connector install/config
 * (`connectors:write`) and all `settings:*` / `users:*` writes — those stay UI/session-only.
 * A credential's scopes are still additionally clamped to the granting user's own role.
 */
export const GRANTABLE_TOKEN_SCOPES: Permission[] = [
  'connectors:read',
  'monitors:read',
  'logs:read',
  'audit:read',
  'users:read',
  'settings:read',
  'automations:read',
  'replicator:read',
  // Write / action scopes:
  'connectors:action',
  'monitors:write',
  // NOTE: automations:write is intentionally NOT grantable to a bearer token — the
  // automation engine runs a rule's actions (connector actions, notifications, raw
  // webhooks) as an unscoped system actor, so a token holding only automations:write
  // could otherwise perform infra actions it has no scope for. It stays session-only.
  'notifications:send',
  // Fabric: read (list agents) + connect (open a tunnel) — enables the native
  // `cerebro access` CLI. `fabric:manage` stays session-only (enroll/revoke).
  'fabric:read',
  'fabric:connect',
];

/** True for a grantable scope that lets a credential change state (not read-only). */
export function isWriteScope(scope: Permission): boolean {
  return !scope.endsWith(':read');
}

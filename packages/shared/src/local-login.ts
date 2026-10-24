/** Local (email + password) sign-in IP policy. See docs/local-login-policy.md. */

/**
 * Who may use email + password sign-in. SSO is never affected. An empty
 * `allowedCidrs` means "from anywhere"; otherwise the client IP must fall in one of
 * the ranges. `enabled: false` turns password sign-in off for everyone.
 */
export interface LocalLoginPolicy {
  enabled: boolean;
  allowedCidrs: string[];
}

/** Admin view of the policy, plus how it applies to the caller right now. */
export interface LocalLoginPolicyView extends LocalLoginPolicy {
  /** The caller's IP as the server sees it (after `trust proxy`). */
  yourIp: string | null;
  /** Whether the caller could use password sign-in under the saved policy. */
  yourIpAllowed: boolean;
  /** The command to run in the container to undo a lockout. */
  breakGlassCommand: string;
}

/** Public: whether the login page should offer the password form to this client. */
export interface LocalLoginAvailability {
  available: boolean;
}

/** RFC1918 + loopback + IPv6 ULA/loopback — the "home / office LAN" preset. */
export const PRIVATE_NETWORK_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  'fc00::/7',
  '::1/128',
];

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Credential primitives for Fabric agents. Two kinds of secret, both stored only
 * as sha256 (never plaintext), mirroring the API-token scheme in
 * auth/token-auth.service.ts:
 *
 *  - **Enrollment token** (`cbroenroll_<secret>`) — one-time, TTL'd. The installer
 *    exchanges it once for a long-lived credential, then it is cleared.
 *  - **Agent credential** (`cbroagent_<prefix>_<secret>`) — long-lived. `prefix` is
 *    a public indexed lookup id; only sha256(secret) is stored.
 *
 * mTLS is the Phase-5 hardening target; a bearer credential over TLS is the Phase-1
 * authenticator (works cleanly through the reverse proxy that terminates TLS).
 */

const ENROLL_PREFIX = 'cbroenroll_';
const CRED_PREFIX = 'cbroagent_';

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time compare of two hex-encoded digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function generateEnrollToken(): { plaintext: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  return { plaintext: `${ENROLL_PREFIX}${secret}`, hash: sha256(secret) };
}

/** Extract the secret from an enrollment token, or null if malformed. */
export function parseEnrollToken(token: string): string | null {
  if (!token || !token.startsWith(ENROLL_PREFIX)) return null;
  const secret = token.slice(ENROLL_PREFIX.length);
  return secret.length ? secret : null;
}

export function generateCredential(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString('hex'); // 12 hex chars
  const secret = randomBytes(24).toString('base64url');
  return { plaintext: `${CRED_PREFIX}${prefix}_${secret}`, prefix, hash: sha256(secret) };
}

/** Split an agent credential into its lookup prefix and secret, or null if malformed. */
export function parseCredential(token: string): { prefix: string; secret: string } | null {
  if (!token || !token.startsWith(CRED_PREFIX)) return null;
  const rest = token.slice(CRED_PREFIX.length);
  const sep = rest.indexOf('_');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return { prefix: rest.slice(0, sep), secret: rest.slice(sep + 1) };
}

// Secrets vault — first-class credential management over the existing encrypted
// Secret store. Metadata only ever crosses the wire; the ciphertext/value never
// leaves the server. See docs/secrets-vault.md.

export type SecretCategory = 'connector' | 'notification' | 'api' | 'manual';

export const SECRET_CATEGORIES: SecretCategory[] = ['connector', 'notification', 'api', 'manual'];

/** Health derived server-side from the rotation policy + age. */
export type SecretHealth = 'ok' | 'due' | 'expired';

/** Metadata for one vault entry. Never carries the secret value. */
export interface SecretSummary {
  key: string;
  label: string;
  description?: string | null;
  kind: SecretKind;
  category: SecretCategory;
  owningConnectorId?: string | null;
  rotateAfterDays?: number | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  rotatedAt: string;
  createdAt: string;
  health: SecretHealth;
  /** Whole days since the secret was last set/rotated. */
  ageDays: number;
}

/** Editable metadata fields (PUT /api/secrets/:key). */
/** Shape of a stored secret value: a single string, or a structured JSON credential. */
export type SecretKind = 'generic' | 'git' | 'ssh' | 'rdp';

/** A Git credential's decoded value (stored as the secret's JSON plaintext, kind='git'). */
export interface GitCredential {
  host?: string;
  username?: string;
  /** A personal-access-token or a password — both authenticate as HTTPS username:secret. */
  secret: string;
}

/** An SSH credential's decoded value (stored as the secret's JSON plaintext, kind='ssh'). */
export interface SshCredential {
  username: string;
  /** Provide a password OR a private key. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** An RDP credential's decoded value (stored as the secret's JSON plaintext, kind='rdp'). */
export interface RdpCredential {
  username: string;
  password: string;
  domain?: string;
}

export interface SecretMetaInput {
  label?: string;
  description?: string | null;
  kind?: SecretKind;
  category?: SecretCategory;
  rotateAfterDays?: number | null;
  expiresAt?: string | null;
}

/** Body for PUT /api/secrets/:key. `value` present = set/rotate the secret too. */
export interface SecretUpsertInput extends SecretMetaInput {
  /** New plaintext value. Omit to edit metadata only. Never returned by any read. */
  value?: string;
}

/**
 * Body for POST /api/secrets/:key/reveal — step-up re-authentication. Reveal is
 * the only read path that returns a value to a client, so it re-verifies the
 * caller's own credentials on EVERY call (nothing is cached): the account password
 * (for local accounts) and a live TOTP code (when two-factor is enabled). See
 * docs/secrets-vault.md.
 */
export interface RevealSecretInput {
  /** The caller's own account password. Required for local accounts. */
  password?: string;
  /** A current 6-digit authenticator code. Required when the caller has TOTP enabled. */
  totp?: string;
}

/** Response for a successful reveal — the decrypted plaintext, returned once. */
export interface RevealSecretResult {
  value: string;
}

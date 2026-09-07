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
/** Shape of a stored secret value: a single string, or a structured Git credential (JSON). */
export type SecretKind = 'generic' | 'git';

/** A Git credential's decoded value (stored as the secret's JSON plaintext, kind='git'). */
export interface GitCredential {
  host?: string;
  username?: string;
  /** A personal-access-token or a password — both authenticate as HTTPS username:secret. */
  secret: string;
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

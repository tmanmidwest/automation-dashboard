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
export interface SecretMetaInput {
  label?: string;
  description?: string | null;
  category?: SecretCategory;
  rotateAfterDays?: number | null;
  expiresAt?: string | null;
}

/** Body for PUT /api/secrets/:key. `value` present = set/rotate the secret too. */
export interface SecretUpsertInput extends SecretMetaInput {
  /** New plaintext value. Omit to edit metadata only. Never returned by any read. */
  value?: string;
}

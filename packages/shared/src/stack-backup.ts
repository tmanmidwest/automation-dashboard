// Stack backup & restore — back up a Compose stack's data, config and metadata
// from any Docker host into a restic repository, and (from Phase 3) restore it to
// the same host or a different one. See docs/stack-backup.md.
//
// Phase 1 covers targets, capture and manual backups. The scheduling fields on a
// policy exist from day one so Phase 4 turns them on without a migration.

/** Storage backend behind a restic repository. */
export type BackupTargetKind = 'b2' | 's3';

/** How the stack's `.env` is captured. See "Secrets" in docs/stack-backup.md. */
export type SecretMode =
  | 'embed' // values included, sealed under a passphrase (survives losing Cerebro)
  | 'raw' // `.env` verbatim, protected only by restic's own encryption
  | 'reference'; // values replaced by ${vault:key} placeholders (Phase 2)

/** Capture consistency. Only 'hot' is implemented in Phase 1. */
export type QuiesceMode = 'hot' | 'pause' | 'stop';

/** How bytes reach the repository. Only 'direct' is implemented in Phase 1. */
export type TransferMode = 'direct' | 'relay';

/** Structured schedule — dropdowns, never cron (Phase 4 runs these). */
export type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

/** A restic repository Cerebro writes stack backups into. Secrets are never returned. */
export interface StackBackupTarget {
  id: string;
  name: string;
  kind: BackupTargetKind;
  repository: string;
  helperImage: string;
  /** True when a separate append-only credential is configured for Docker hosts. */
  hasHostCred: boolean;
  keepLast?: number | null;
  keepDaily?: number | null;
  keepWeekly?: number | null;
  keepMonthly?: number | null;
  keepWithinDays?: number | null;
  /** never | ok | error — result of the last repository probe. */
  lastStatus: string;
  lastMessage?: string | null;
  lastCheckedAt?: string | null;
  /** How many stack policies write here (blocks deletion while non-zero). */
  policyCount: number;
  createdAt: string;
}

/** Create/update a target. Credentials are plaintext on the way in only — the
 *  server writes them straight to the vault and never reads them back out here. */
export interface SaveBackupTargetInput {
  name: string;
  kind: BackupTargetKind;
  repository: string;
  /** Restic repository password. Required on create; omit on update to keep the stored one. */
  password?: string;
  /** B2: the keyID. S3: the access key id. */
  accessKeyId?: string;
  /** B2: the applicationKey. S3: the secret access key. */
  secretAccessKey?: string;
  /** Optional append-only credential pushed to Docker hosts instead of the full one. */
  hostAccessKeyId?: string;
  hostSecretAccessKey?: string;
  helperImage?: string;
  keepLast?: number | null;
  keepDaily?: number | null;
  keepWeekly?: number | null;
  keepMonthly?: number | null;
  keepWithinDays?: number | null;
}

/** What gets captured for one stack on one Docker host. */
export interface StackBackupPolicy {
  id: string;
  connectorInstanceId: string;
  /** Resolved connector instance name, for display. */
  hostName?: string;
  stackName: string;
  targetId: string;
  targetName?: string;
  enabled: boolean;
  frequency: BackupFrequency;
  dayOfWeek: number;
  dayOfMonth: number;
  hour: number;
  minute: number;
  quiesce: QuiesceMode;
  transfer: TransferMode;
  secretMode: SecretMode;
  includeBinds: string[];
  excludes: string[];
  lastRunAt?: string | null;
  /** never | running | success | error. */
  lastStatus: string;
  lastMessage?: string | null;
  createdAt: string;
}

export interface SaveBackupPolicyInput {
  connectorInstanceId: string;
  stackName: string;
  targetId: string;
  enabled?: boolean;
  frequency?: BackupFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  hour?: number;
  minute?: number;
  quiesce?: QuiesceMode;
  transfer?: TransferMode;
  secretMode?: SecretMode;
  includeBinds?: string[];
  excludes?: string[];
}

/** One backup attempt. */
export interface StackBackupRun {
  id: string;
  policyId?: string | null;
  connectorInstanceId: string;
  hostName?: string;
  stackName: string;
  targetId: string;
  targetName?: string;
  trigger: 'manual' | 'schedule';
  /** running | success | error. */
  status: string;
  snapshotId?: string | null;
  bytesAdded?: number | null;
  bytesTotal?: number | null;
  filesNew?: number | null;
  filesTotal?: number | null;
  volumes: number;
  binds: number;
  durationMs?: number | null;
  message?: string | null;
  /** Only returned by the single-run endpoint — the list omits it. */
  log?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** Start a backup. The policy decides what is captured; this only supplies runtime input. */
export interface RunBackupInput {
  /** Required when the policy's secretMode is 'embed' — seals the captured values. */
  passphrase?: string;
}

/** One bind-mount path a stack's containers use, offered for opt-in inclusion. */
export interface StackBindPath {
  path: string;
  /** Containers mounting it, for context in the picker. */
  containers: string[];
  readOnly: boolean;
}

/** What Cerebro can see about a stack before a policy exists — drives the "add" form. */
export interface StackBackupCandidate {
  connectorInstanceId: string;
  hostName: string;
  stackName: string;
  containers: number;
  /** Named volumes that would be captured (always included). */
  volumes: string[];
  /** Bind paths found on the stack's containers — none are captured unless opted in. */
  binds: StackBindPath[];
  /** Cerebro stores this stack's compose (DockerStack row). */
  managed: boolean;
  /** A policy already exists for this stack. */
  configured: boolean;
  /** False when the host has no SSH configured — Phase 1 cannot back it up. */
  backupable: boolean;
  /** Why not, when backupable is false. */
  reason?: string;
}

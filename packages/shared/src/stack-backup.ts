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
  preHooks: StackHook[];
  postHooks: StackHook[];
  lastRunAt?: string | null;
  /** never | running | success | error. */
  lastStatus: string;
  lastMessage?: string | null;
  /** A sealing passphrase is stored in the vault, so scheduled runs can seal
   *  without an operator present. Required before a sealed backup can be scheduled. */
  hasSealPassphrase: boolean;
  /** ISO8601 of the next scheduled fire, or null when the schedule is off. */
  nextRunAt?: string | null;
  /** Human rendering of the schedule, e.g. "Weekly on Sunday at 04:00 (server time)". */
  scheduleText: string;
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
  preHooks?: StackHook[];
  postHooks?: StackHook[];
  /**
   * Passphrase used to seal this stack's secrets on every run, stored in the
   * vault so the scheduler can run unattended. Omit to keep the stored one; pass
   * an empty string to clear it. Record it somewhere outside Cerebro — it is what
   * makes a sealed backup restorable when Cerebro itself is gone.
   */
  sealPassphrase?: string;
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
  /** False only when nothing can back this stack up at all. */
  backupable: boolean;
  /** The host has no SSH, so only relay transfer can reach it. */
  requiresRelay: boolean;
  /** Extra context for the operator (e.g. why relay is required). */
  reason?: string;
}

// ── Restore (Phase 3) ────────────────────────────────────────────────────────

/** A stack snapshot in a repository, with Cerebro's tags decoded. */
export interface StackSnapshot {
  id: string;
  shortId: string;
  /** ISO8601. */
  time: string;
  /** The Docker host the snapshot was taken from, as restic recorded it. */
  hostname?: string;
  stackName?: string;
  /** Source connector instance id, when the tag is still resolvable. */
  hostId?: string;
  /** Resolved source host name, when that connector instance still exists. */
  hostLabel?: string;
  policyId?: string;
  runId?: string;
}

/** One entry when browsing a snapshot's contents. */
export interface SnapshotEntry {
  path: string;
  name: string;
  type: string;
  size?: number;
}

/** What a restore does with the stack's configuration. */
export type RestoreMode =
  | 'full' // volumes + compose/.env, and optionally bring the stack up
  | 'data' // volumes/binds only — leave the running stack's configuration alone
  | 'verify'; // restore into a throwaway sandbox stack, health-check it, tear it down

/** Per-variable outcome of resolving a snapshot's secrets against the live vault. */
export type SecretState =
  | 'resolved' // vault holds the same value the snapshot was taken with
  | 'drifted' // vault holds a DIFFERENT value than at capture time
  | 'missing' // the bound vault key is gone
  | 'sealed' // the value comes from the snapshot's sealed blob (needs the passphrase)
  | 'plain'; // the value comes from the snapshot in the clear (raw mode)

export interface RestoreSecret {
  name: string;
  vaultKey?: string;
  origin?: string;
  state: SecretState;
}

export interface RestorePlanInput {
  targetId: string;
  snapshotId: string;
  /** Where to restore. Defaults to the host the snapshot came from, when it still exists. */
  destInstanceId: string;
  /** Defaults to the original compose project name. */
  destStackName?: string;
  /** Captured bind path → where to write it on the destination. Absent paths restore in place. */
  bindMap?: Record<string, string>;
}

/** One volume the restore would write, and where it would land. */
export interface RestoreVolumePlan {
  /** Volume name as stored in the snapshot. */
  source: string;
  /** Volume name to create/write on the destination. */
  dest: string;
  exists: boolean;
  driver?: string;
  /** The restore renamed it because the stack was renamed — compose derives volume
   *  names from the project, so keeping the old name would orphan the data. */
  renamed: boolean;
}

export interface RestoreBindPlan {
  /** Host path as captured. */
  source: string;
  /** Host path to write on the destination. */
  dest: string;
  /** The destination path already exists on the target host. */
  exists: boolean;
  /** The operator remapped this path rather than restoring it in place. */
  remapped: boolean;
}

/** One host port the restored stack would publish, and whether it is free. */
export interface RestorePortPlan {
  hostPort: number;
  containerPort?: string;
  inUse: boolean;
}

/** The reviewable plan. Nothing is written until it is executed. */
export interface RestorePlan {
  snapshot: StackSnapshot;
  targetId: string;
  destInstanceId: string;
  destHostName: string;
  destStackName: string;
  sourceStackName: string;
  secretMode: SecretMode;
  volumes: RestoreVolumePlan[];
  binds: RestoreBindPlan[];
  /** The snapshot carries a compose file, so a 'full' restore can redeploy. */
  hasCompose: boolean;
  /** The snapshot carries an `.env`. */
  hasEnv: boolean;
  secrets: RestoreSecret[];
  /** Host ports the restored stack would publish, checked against the destination. */
  ports: RestorePortPlan[];
  /** Credential files held in this snapshot (sealed), and whether they can be written back. */
  credentialFiles: { path: string; writable: boolean }[];
  /** Where the snapshot's tree is rooted — '/data' for a direct capture, a staging
   *  path for a relay one. Restore derives its paths from this. */
  captureRoot: string;
  /** True when executing needs the sealing passphrase. */
  needsPassphrase: boolean;
  /** Blocking problems — the restore refuses until they are resolved or overridden. */
  conflicts: string[];
  /** Non-blocking things the operator should read before saying yes. */
  warnings: string[];
}

export interface ExecuteRestoreInput extends RestorePlanInput {
  mode: RestoreMode;
  /** Volume source names to restore. Omit for all of them. */
  volumes?: string[];
  /** Bind source paths to restore. Omit for none — binds overwrite host paths. */
  binds?: string[];
  /** Write captured credential files back to their host paths. Off by default: it
   *  writes outside the stack's own volumes. */
  restoreCredentialFiles?: boolean;
  /** Required when the snapshot's secrets are sealed and a 'full' restore is writing `.env`. */
  passphrase?: string;
  /** 'full' only: run `docker compose up -d` after writing the configuration. */
  deploy?: boolean;
  /** Proceed despite conflicts (existing volumes, a stack already running there). */
  force?: boolean;
}

/** One restore attempt. */
export interface StackRestoreRun {
  id: string;
  snapshotId: string;
  targetId: string;
  sourceStackName: string;
  destInstanceId: string;
  destHostName?: string;
  destStackName: string;
  mode: RestoreMode;
  /** running | success | error. */
  status: string;
  message?: string | null;
  volumes: number;
  binds: number;
  deployed: boolean;
  durationMs?: number | null;
  /** Only returned by the single-run endpoint. */
  log?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** A Docker host a backup can be taken from or restored onto. */
export interface BackupHost {
  id: string;
  name: string;
  enabled: boolean;
  /** False when the connector has no SSH — backup and restore both need it. */
  backupable: boolean;
}

// ── Secret bindings (Phase 2) ────────────────────────────────────────────────

/** Where a variable→vault-key binding came from, strongest first. */
export type BindingOrigin =
  | 'declared' // an operator said so — outranks everything
  | 'replicator' // the App Replicator put this value in the vault itself
  | 'git-credential' // the vault git credential a git-sourced stack clones with
  | 'inferred'; // the live value's keyed digest matches a vault entry

/** How a stack variable currently stands against the vault. */
export type BindingState =
  | 'bound' // the vault holds this exact value
  | 'drifted' // bound to a key whose value has since changed
  | 'missing' // bound to a key that no longer exists
  | 'unbound'; // nothing in the vault matches

/** One variable of a stack, as the secrets view shows it. Never carries a value. */
export interface StackSecretView {
  name: string;
  /** Containers in the stack that carry this variable. */
  containers: string[];
  /** The name looks like a credential. */
  secretish: boolean;
  vaultKey?: string | null;
  origin?: BindingOrigin | null;
  state: BindingState;
}

/** The secrets picture for one stack, plus what it means for the backup modes. */
export interface StackSecretsReport {
  connectorInstanceId: string;
  stackName: string;
  variables: StackSecretView[];
  /** Secret-looking variables with no vault binding. */
  unbound: string[];
  /** Credentials written literally inside the compose file. */
  inlineComposeSecrets: string[];
  /** Host files that are themselves credentials (`*_FILE`, compose `secrets:`). Not captured. */
  fileSecrets: string[];
  /** True when `reference` mode could be used for this stack right now. */
  referenceReady: boolean;
  /** Why not, when referenceReady is false. */
  referenceBlockedBy?: string;
}

/** Bind a variable to an existing vault key, or promote its live value into a new one. */
export interface BindSecretInput {
  varName: string;
  /** Bind to this existing key. Omit with `promote` to have a key generated. */
  vaultKey?: string;
  /** Read the live value off the host and write it into the vault under `vaultKey`. */
  promote?: boolean;
}

/** Which stacks reference each vault key — the vault's reverse index. */
export interface SecretUsage {
  vaultKey: string;
  uses: { connectorInstanceId: string; hostName?: string; stackName: string; varName: string; origin: BindingOrigin }[];
}

// ── Quiesce & hooks (Phase 5) ────────────────────────────────────────────────

/**
 * A command run inside one of the stack's own containers, around the capture.
 *
 * The usual shape is a database dump in a pre-hook, which is what lets a live
 * database be backed up consistently without stopping the stack: redirect the
 * dump into a path inside a volume that is already being captured, e.g.
 * `pg_dump -U postgres app > /var/lib/postgresql/data/cerebro-dump.sql`.
 */
export interface StackHook {
  /** Target by compose service name… */
  service?: string;
  /** …or by exact container name. One of the two is required. */
  container?: string;
  /** Run with `sh -c`, so redirects and pipes work. */
  cmd: string;
  /**
   * Also capture the command's stdout into the snapshot under this filename.
   * For small outputs only (config dumps, `mysqldump` of a tiny schema) — a large
   * dump should redirect into a captured volume instead of being buffered.
   */
  captureTo?: string;
}

/** Restore a snapshot into a throwaway sandbox, health-check it, and tear it down. */
export interface VerifyRestoreInput {
  targetId: string;
  snapshotId: string;
  /** Where to run the trial. Defaults to the host the snapshot came from. */
  destInstanceId: string;
  /** Needed when the snapshot's secrets are sealed. */
  passphrase?: string;
  /** Leave the sandbox running instead of tearing it down (for poking at it). */
  keep?: boolean;
}

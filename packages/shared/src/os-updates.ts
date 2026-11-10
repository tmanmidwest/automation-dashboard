// OS updates — pending updates found by the Cerebro agent, installs, restarts and
// update schedules. See docs/os-updates.md.

export type OsUpdateScope = 'security' | 'all';
export type OsUpdateReboot = 'never' | 'if-needed' | 'always';
/** The box's CEREBRO_OS_UPDATES: on (default), report (check only) or off. */
export type OsUpdateMode = 'on' | 'report' | 'off';

export interface OsUpdatePackage {
  name: string;
  current?: string;
  available?: string;
  security?: boolean;
  /** Vendor severity when published (Windows MSRC, RHEL/Fedora advisories, zypper patches). */
  severity?: string;
  /** Windows: KB number. */
  kb?: string;
  /** Repository / origin / category. */
  source?: string;
  /** Installing it needs a restart (Windows / macOS say so per update). */
  restart?: boolean;
  /** Can't be installed unattended (macOS on Apple silicon). */
  needsUser?: boolean;
}

/** What the agent reports about its last install / restart command. */
export interface OsUpdateAgentRun {
  runId: string;
  kind: 'install' | 'reboot';
  ok: boolean;
  exitCode: number;
  message?: string;
  /** Unix ms. */
  startedAt: number;
  finishedAt: number;
  rebooting?: boolean;
  installed?: number;
}

/** agent → broker report. */
export interface OsUpdateReport {
  /** Unix ms; 0 before the first check finished. */
  checkedAt: number;
  manager?: string;
  supported: boolean;
  error?: string;
  note?: string;
  packages: OsUpdatePackage[];
  total: number;
  security: number;
  securityKnown: boolean;
  rebootRequired: boolean;
  rebootReason?: string;
  canInstall: boolean;
  proxmox?: boolean;
  mode: OsUpdateMode;
  installing?: string;
  checking?: boolean;
  lastRun?: OsUpdateAgentRun;
}

export interface FabricUpdatesFrame {
  t: 'updates';
  report: OsUpdateReport;
}

export interface FabricUpdatesLogFrame {
  t: 'updates-log';
  runId: string;
  lines: string[];
}

export interface FabricUpdatesResultFrame {
  t: 'updates-result';
  result: OsUpdateAgentRun;
}

/** broker → agent: look for updates now. */
export interface FabricUpdatesCheckFrame {
  t: 'updates-check';
}

/**
 * broker → agent: install. Signed (vault signing) over
 * "updates:<credHash>:<issuedAt>:<runId>:install:<scope>:<reboot>".
 */
export interface FabricUpdatesInstallFrame {
  t: 'updates-install';
  runId: string;
  scope: OsUpdateScope;
  reboot: OsUpdateReboot;
  issuedAt?: number;
  sig?: string;
}

/** broker → agent: restart. Signed over "updates:<credHash>:<issuedAt>:<runId>:reboot::". */
export interface FabricUpdatesRebootFrame {
  t: 'updates-reboot';
  runId: string;
  issuedAt?: number;
  sig?: string;
}

/** The Proxmox guest a machine was matched to (by MAC), for snapshots before patching. */
export interface OsUpdateProxmoxGuest {
  instanceId: string;
  instanceName: string;
  vmid: number;
  kind: 'qemu' | 'lxc';
  name: string;
}

/** Per-machine update state shown on Health. */
export interface OsUpdateStatus {
  /** ISO; null before the first report. */
  checkedAt: string | null;
  manager: string | null;
  supported: boolean;
  error: string | null;
  note: string | null;
  total: number;
  security: number;
  securityKnown: boolean;
  rebootRequired: boolean;
  rebootReason: string | null;
  /** ISO: since when security updates / a restart have been waiting. */
  securitySince: string | null;
  rebootSince: string | null;
  canInstall: boolean;
  proxmox: boolean;
  mode: OsUpdateMode;
  /** Run id of an install in progress. */
  installing: string | null;
  checking: boolean;
}

export type OsUpdateRunStatus =
  | 'scheduled'
  | 'snapshot'
  | 'sent'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'refused'
  | 'missed'
  | 'cancelled'
  | 'unknown';

export const OS_UPDATE_RUN_ACTIVE: OsUpdateRunStatus[] = ['scheduled', 'snapshot', 'sent', 'running'];

export interface OsUpdateRun {
  id: string;
  agentId: string;
  agentName: string;
  kind: 'install' | 'reboot';
  trigger: 'manual' | 'schedule';
  scheduleId: string | null;
  scheduleName: string | null;
  /** 0-based ring of the schedule. */
  ring: number | null;
  scope: OsUpdateScope;
  reboot: OsUpdateReboot;
  snapshot: boolean;
  status: OsUpdateRunStatus;
  scheduledFor: string | null;
  windowEnd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  exitCode: number | null;
  installed: number | null;
  rebooting: boolean;
  snapshotName: string | null;
  snapshotNote: string | null;
  requestedBy: string | null;
  pendingBefore: number | null;
  createdAt: string;
  logLines: number;
  /** Detail view only. */
  log?: string[];
}

export interface OsUpdateRing {
  agentIds: string[];
  /** Hours after the window opens before this ring starts (ring 1 is normally 0). */
  delayHours: number;
}

export interface OsUpdateSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  hour: number;
  minute: number;
  windowHours: number;
  scope: OsUpdateScope;
  reboot: OsUpdateReboot;
  snapshot: boolean;
  rings: OsUpdateRing[];
  stopOnFailure: boolean;
  lastFiredAt: string | null;
  /** ISO, server-computed. */
  nextRunAt: string | null;
  /** e.g. "Sun, Wed at 03:00 (server time)". */
  description: string;
}

export type OsUpdateScheduleInput = Omit<OsUpdateSchedule, 'id' | 'lastFiredAt' | 'nextRunAt' | 'description'>;

/** Whether Cerebro can send signed commands, which agents with a pinned update key require. */
export interface OsUpdateSigning {
  /** off: no update signing (agents accept unsigned); vault: Cerebro signs; offline: can't sign. */
  mode: 'off' | 'vault' | 'offline';
  canSign: boolean;
  message?: string;
}

/** One machine on the Updates tab. */
export interface OsUpdateMachine extends OsUpdateStatus {
  agentId: string;
  name: string;
  os: string | null;
  online: boolean;
  role: 'server' | 'workstation';
  agentVersion: string | null;
  /** Agent too old to report updates (before 0.7). */
  agentTooOld: boolean;
  proxmoxGuest: OsUpdateProxmoxGuest | null;
  lastRun: OsUpdateRun | null;
}

export interface OsUpdateOverview {
  machines: OsUpdateMachine[];
  runs: OsUpdateRun[];
  schedules: OsUpdateSchedule[];
  signing: OsUpdateSigning;
  totals: { machines: number; withUpdates: number; withSecurity: number; needRestart: number; failedRuns: number };
}

export interface OsUpdateMachineDetail {
  machine: OsUpdateMachine;
  packages: OsUpdatePackage[];
  runs: OsUpdateRun[];
}

export interface OsUpdateInstallRequest {
  agentIds: string[];
  scope: OsUpdateScope;
  reboot: OsUpdateReboot;
  /** Take a Proxmox snapshot first (machines matched to a Proxmox guest only). */
  snapshot?: boolean;
  /** ISO; absent = now. */
  at?: string;
}

export interface OsUpdateRebootRequest {
  agentIds: string[];
  at?: string;
}

/** Posture/alerts: security updates waiting longer than this are flagged. */
export const OS_UPDATE_SECURITY_GRACE_DAYS = 7;
export const OS_UPDATE_REBOOT_GRACE_DAYS = 7;

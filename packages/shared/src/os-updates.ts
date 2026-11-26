// OS updates — pending updates found by the Cerebro agent, installs, restarts and
// update schedules. See docs/os-updates.md.

/**
 * security / all: what a regular upgrade installs. full (apt only, agent 0.8+): also
 * the held-back packages, with a full upgrade (dist-upgrade) that can add or remove
 * packages. Schedules use security / all only.
 */
export type OsUpdateScope = 'security' | 'all' | 'full';
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
  /**
   * apt: held back. A regular upgrade ("All updates") won't install it because it
   * needs other packages added or removed; only a full upgrade does.
   */
  heldBack?: boolean;
  /** apt (agent 0.10+): the source package it's built from (what advisories are filed under). */
  sourcePackage?: string;
  /** CVEs this update fixes: from the package manager (dnf, Windows) or Cerebro's OSV.dev lookup (apt). */
  cves?: string[];
  /** Advisories it belongs to (USN-…, DSA-…, RHSA-…, FEDORA-…, MS bulletins). */
  advisories?: string[];
  /** Cerebro: how much it matters (see OS_UPDATE_PRIORITY_ORDER). Absent until worked out. */
  priority?: OsUpdatePriority;
  /** Cerebro: highest CVSS among its CVEs. */
  maxCvss?: number;
  /** Cerebro: fixes a CVE on CISA's Known Exploited Vulnerabilities list. */
  kev?: boolean;
  /** Cerebro: highest EPSS (0–1, chance of exploitation in the next 30 days) among its CVEs. */
  epss?: number;
}

/**
 * How much an update matters, highest first:
 *  patch-now  fixes a CVE CISA lists as exploited in the wild (KEV)
 *  critical   CVSS 9+, or the vendor / distro calls it critical
 *  important  CVSS 7–8.9, or vendor Important / High
 *  security   a security fix of lower or unknown severity
 *  regular    not a security fix
 */
export type OsUpdatePriority = 'patch-now' | 'critical' | 'important' | 'security' | 'regular';
export const OS_UPDATE_PRIORITY_ORDER: OsUpdatePriority[] = ['patch-now', 'critical', 'important', 'security', 'regular'];
export const OS_UPDATE_PRIORITY_LABEL: Record<OsUpdatePriority, string> = {
  'patch-now': 'Patch now',
  critical: 'Critical',
  important: 'Important',
  security: 'Security',
  regular: 'Regular',
};
/** 0 = most urgent; unknown / null sorts after regular. */
export function osUpdatePriorityRank(p: OsUpdatePriority | null | undefined): number {
  const i = p ? OS_UPDATE_PRIORITY_ORDER.indexOf(p) : -1;
  return i < 0 ? OS_UPDATE_PRIORITY_ORDER.length : i;
}

/** /etc/os-release facts the agent reports (Linux, agent 0.10+). */
export interface OsUpdateDistro {
  id: string;
  versionId?: string;
  codename?: string;
  idLike?: string;
}

/** One CVE on the machine detail view. */
export interface OsUpdateCve {
  id: string;
  cvss: number | null;
  /** Vendor priority (e.g. Ubuntu "high"). */
  priority: string | null;
  summary: string | null;
  epss: number | null;
  epssPercentile: number | null;
  /** On CISA KEV. */
  kev: { dateAdded: string | null; dueDate: string | null; name: string | null; ransomware: boolean } | null;
}

export interface OsUpdateLink {
  label: string;
  url: string;
}

const RHEL_LIKE = ['rhel', 'centos', 'rocky', 'almalinux', 'ol', 'fedora'];

/** Where to read about a CVE for this machine: the distro / vendor page first, then NVD. */
export function osUpdateCveLinks(cve: string, manager: string | null | undefined, distroId: string | null | undefined): OsUpdateLink[] {
  const id = encodeURIComponent(cve);
  const d = (distroId ?? '').toLowerCase();
  const out: OsUpdateLink[] = [];
  if (manager === 'windows-update') out.push({ label: 'Microsoft', url: `https://msrc.microsoft.com/update-guide/vulnerability/${id}` });
  else if (d === 'ubuntu') out.push({ label: 'Ubuntu', url: `https://ubuntu.com/security/${id}` });
  else if (d === 'debian' || d === 'raspbian') out.push({ label: 'Debian', url: `https://security-tracker.debian.org/tracker/${id}` });
  else if (RHEL_LIKE.includes(d) || manager === 'dnf' || manager === 'yum') out.push({ label: 'Red Hat', url: `https://access.redhat.com/security/cve/${id}` });
  else if (manager === 'zypper') out.push({ label: 'SUSE', url: `https://www.suse.com/security/cve/${id}/` });
  out.push({ label: 'NVD', url: `https://nvd.nist.gov/vuln/detail/${id}` });
  return out;
}

/** Link for an advisory id (USN, DSA/DLA, RHSA, Rocky, Alma, Oracle, Fedora) or a Windows KB; null when unknown. */
export function osUpdateAdvisoryLink(advisory: string): string | null {
  const a = advisory.trim();
  const e = encodeURIComponent(a);
  if (/^USN-\d+-\d+$/.test(a)) return `https://ubuntu.com/security/notices/${e}`;
  if (/^(DSA|DLA)-\d+(-\d+)?$/.test(a)) return `https://security-tracker.debian.org/tracker/${e}`;
  if (/^RH[SBE]A-\d{4}:\d+$/.test(a)) return `https://access.redhat.com/errata/${e}`;
  if (/^RLSA-\d{4}:\d+$/.test(a)) return `https://errata.rockylinux.org/${e}`;
  if (/^ALSA-\d{4}:\d+$/.test(a)) return `https://errata.almalinux.org/`;
  if (/^ELSA-\d{4}-\d+$/.test(a)) return `https://linux.oracle.com/errata/${e}.html`;
  if (/^FEDORA(-EPEL)?-\d{4}-[0-9a-f]+$/i.test(a)) return `https://bodhi.fedoraproject.org/updates/${e}`;
  if (/^KB\d+$/i.test(a)) return `https://support.microsoft.com/help/${a.slice(2)}`;
  return null;
}

/** What the agent reports about its last install / restart command. */
/** install / reboot, or repair (apt, agent 0.9+): stop a stuck apt/dpkg and finish half-done package setup. */
export type OsUpdateRunKind = 'install' | 'reboot' | 'repair';

export interface OsUpdateAgentRun {
  runId: string;
  kind: OsUpdateRunKind;
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
  /** Linux, agent 0.10+. */
  distro?: OsUpdateDistro;
  supported: boolean;
  error?: string;
  note?: string;
  packages: OsUpdatePackage[];
  /** What "All updates" / "Security only" would install (agent 0.8+: held-back packages excluded). */
  total: number;
  security: number;
  /** apt, agent 0.8+: packages only a full upgrade installs. */
  heldBack?: number;
  /** apt, agent 0.8+: packages a full upgrade would remove. */
  fullUpgradeRemoves?: string[];
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

/**
 * broker → agent: repair the package manager (apt): stop an apt/dpkg that has held
 * the lock for 10+ minutes, then dpkg --configure -a and apt-get -f install.
 * Signed over "updates:<credHash>:<issuedAt>:<runId>:repair::".
 */
export interface FabricUpdatesRepairFrame {
  t: 'updates-repair';
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
  /** Held-back packages (apt): only "Include held-back (full upgrade)" installs them. Not in total. */
  heldBack: number;
  /** Packages that full upgrade would remove. */
  fullUpgradeRemoves: string[];
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
  /** Highest priority among pending updates (null: none, or not worked out yet). */
  priority: OsUpdatePriority | null;
  /** Distinct CVEs the pending updates fix. */
  cveCount: number;
  /** Updates that fix a known-exploited (CISA KEV) CVE, and those CVEs. */
  kevCount: number;
  kevCves: string[];
  /** ISO: since when a patch-now update has been waiting. */
  patchNowSince: string | null;
  /** Installed updates of this priority need the restart to take effect. */
  restartPriority: OsUpdatePriority | null;
  /** ISO: when CVE / priority detail was last worked out. */
  enrichedAt: string | null;
  /** Why CVE detail is missing or partial. */
  enrichNote: string | null;
  distro: OsUpdateDistro | null;
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
  kind: OsUpdateRunKind;
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
  /** Can take scope "full" (apt, not Proxmox, agent 0.8+). */
  canFullUpgrade: boolean;
  /** Can take Repair (apt, agent 0.9+). */
  canRepair: boolean;
  proxmoxGuest: OsUpdateProxmoxGuest | null;
  lastRun: OsUpdateRun | null;
}

export interface OsUpdateOverview {
  machines: OsUpdateMachine[];
  runs: OsUpdateRun[];
  schedules: OsUpdateSchedule[];
  signing: OsUpdateSigning;
  totals: { machines: number; withUpdates: number; withSecurity: number; needRestart: number; failedRuns: number; knownExploited: number };
}

export interface OsUpdateMachineDetail {
  machine: OsUpdateMachine;
  packages: OsUpdatePackage[];
  /** Details for every CVE in packages[].cves. */
  cves: Record<string, OsUpdateCve>;
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

export interface OsUpdateRepairRequest {
  agentIds: string[];
}

/** Posture/alerts: security updates waiting longer than this are flagged. */
export const OS_UPDATE_SECURITY_GRACE_DAYS = 7;
export const OS_UPDATE_REBOOT_GRACE_DAYS = 7;
/** Posture/alerts: a patch-now (known exploited) update waiting longer than this is flagged. */
export const OS_UPDATE_PATCH_NOW_GRACE_DAYS = 2;

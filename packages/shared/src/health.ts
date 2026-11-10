// Health monitoring — resource health reported by the Cerebro agent.
// See docs/health-monitoring.md.

/** One filesystem in a health sample. */
export interface HealthDisk {
  mount: string;
  device?: string;
  fs?: string;
  totalBytes: number;
  usedBytes: number;
  /** Used %. */
  pct: number;
  /** Linux only: inodes used %. */
  inodesPct?: number;
}

/** One sample as the agent sends it. Absent fields = the OS doesn't expose it. */
export interface HealthSample {
  /** Unix ms, end of the sample window. */
  at: number;
  /** Seconds this sample covers. */
  spanSec: number;
  cpuPct?: number;
  /** Peak of the ~10 s sub-samples inside the window. */
  cpuMaxPct?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  memTotal?: number;
  memUsed?: number;
  memPct?: number;
  swapTotal?: number;
  swapUsed?: number;
  swapPct?: number;
  disks?: HealthDisk[];
  diskReadBps?: number;
  diskWriteBps?: number;
  netRxBps?: number;
  netTxBps?: number;
  uptimeSec?: number;
  procs?: number;
}

/** Hardware / OS facts, sent on connect and every few hours. */
export interface HealthInventory {
  hostname?: string;
  os: string;
  arch: string;
  platform?: string;
  platformVersion?: string;
  platformFamily?: string;
  kernelVersion?: string;
  cpuModel?: string;
  cpuCores?: number;
  cpuThreads?: number;
  memTotal?: number;
  /** kvm, vmware, lxc, docker, … when virtualized. */
  virtSystem?: string;
  /** "guest" | "host". */
  virtRole?: string;
  hasBattery: boolean;
  /** Unix seconds. */
  bootTime?: number;
  macs?: string[];
  ips?: string[];
}

/** agent → broker: queued samples (a backlog after a reconnect) + inventory when due. */
export interface FabricHealthFrame {
  t: 'health';
  samples?: HealthSample[];
  inventory?: HealthInventory;
}

/** broker → agent: change the reporting cadence live (0 disables). */
export interface FabricHealthConfigFrame {
  t: 'health-config';
  healthIntervalMs: number;
}

/** broker → agent: report a fresh sample now. */
export interface FabricHealthNowFrame {
  t: 'health-now';
}

/** How a machine is treated: servers alert when offline; workstations don't. */
export type HealthRole = 'server' | 'workstation';

export type HealthStatus = 'ok' | 'warning' | 'critical' | 'offline' | 'unknown';

export type HealthIssueKey = 'offline' | 'disk' | 'memory' | 'cpu' | 'inodes' | 'stale';

export interface HealthIssue {
  key: HealthIssueKey;
  severity: 'warning' | 'critical';
  message: string;
  /** e.g. the mount for a disk issue. */
  subject?: string;
}

/** Global thresholds (Settings `health.thresholds`). Durations in minutes. */
export interface HealthThresholds {
  diskWarnPct: number;
  diskCritPct: number;
  memWarnPct: number;
  memCritPct: number;
  /** Memory must stay over its limit this long before it counts. */
  memMinutes: number;
  cpuWarnPct: number;
  cpuMinutes: number;
  /** A server offline this long raises a critical issue (alerting itself is Fabric's offline alert). */
  offlineMinutes: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  diskWarnPct: 85,
  diskCritPct: 95,
  memWarnPct: 90,
  memCritPct: 97,
  memMinutes: 15,
  cpuWarnPct: 95,
  cpuMinutes: 15,
  offlineMinutes: 3,
};

export interface HealthSettings {
  /** Reporting cadence pushed to every agent. 0 = health collection off. */
  intervalSec: number;
  thresholds: HealthThresholds;
}

export const DEFAULT_HEALTH_INTERVAL_SEC = 30;

/** Online/offline seconds over a window. offlineSec counts only time since the agent was enrolled. */
export interface HealthAvailability {
  windowSec: number;
  onlineSec: number;
  offlineSec: number;
  /** 0–100, null when the window has no coverage at all yet. */
  pct: number | null;
}

/** One row on the Health page. */
export interface HealthMachine {
  agentId: string;
  name: string;
  hostname?: string | null;
  os?: string | null;
  osVersion?: string | null;
  localIp?: string | null;
  tags: string[];
  /** Fabric agent connection status. */
  online: boolean;
  lastSeenAt?: string | null;
  role: HealthRole;
  /** True when the role was set by an operator (not auto-detected). */
  roleOverridden: boolean;
  status: HealthStatus;
  /** 0–100; null while there's no data (or a workstation is just offline). */
  score: number | null;
  issues: HealthIssue[];
  /** Latest sample; null until the agent's first report (or an agent older than 0.6). */
  latest: HealthSample | null;
  /** ISO time of the latest sample. */
  latestAt?: string | null;
  inventory: HealthInventory | null;
  agentVersion?: string | null;
  /** Last 24 h of CPU / memory, ~48 points, for sparklines. */
  spark: { at: string; cpu: number | null; mem: number | null }[];
  availability: { day: HealthAvailability; week: HealthAvailability; month: HealthAvailability };
}

export interface HealthFleet {
  machines: HealthMachine[];
  totals: { machines: number; ok: number; warning: number; critical: number; offline: number; unknown: number };
  settings: HealthSettings;
}

export type HealthRange = '1h' | '24h' | '7d' | '30d';

/** One chart point (averages over the point's bucket; *Max = peak). */
export interface HealthSeriesPoint {
  at: string;
  cpu: number | null;
  cpuMax: number | null;
  mem: number | null;
  swap: number | null;
  disk: number | null;
  netRx: number | null;
  netTx: number | null;
  read: number | null;
  write: number | null;
  /** Per-mount used %. */
  disks: Record<string, number> | null;
}

export interface HealthSeries {
  range: HealthRange;
  /** "raw" | "5m" | "1h" — the resolution the points came from. */
  resolution: string;
  points: HealthSeriesPoint[];
}

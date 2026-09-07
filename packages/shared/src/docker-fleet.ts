// Aggregated multi-host Docker view ("Docker Fleet"). One merged tree across
// every enabled Docker connector instance, built server-side from each
// connector's existing overview + resource lists. See the DockerFleet screen.

/** One container within a host's stack. */
export interface FleetMember {
  instanceId: string;
  id: string;        // container id
  name: string;
  image: string;
  service?: string;
  /** running | exited | paused | unhealthy | created | restarting | dead | … */
  status: string;
  /** A newer image is available in the registry. */
  hasUpdate: boolean;
}

/** A compose project (or the synthetic "ungrouped" bucket) on one host. */
export interface FleetStack {
  instanceId: string;
  id: string;        // compose project name (stack id)
  name: string;
  /** running | degraded | stopped | unhealthy | error | … */
  status: string;
  containers: number;
  running: number;
  /** How many member containers have an image update available. */
  updates: number;
  /** Cerebro-managed (has stored compose → redeploy/rollback/drift available). */
  managed: boolean;
  members: FleetMember[];
}

/** Per-host rollup + telemetry. */
export interface FleetHostMetrics {
  running: number;
  stopped: number;
  unhealthy: number;
  restarting: number;
  updates: number;
  images?: number;
  diskUsedGb?: number;
  hostLoadPct?: number;
  hostMemUsedPct?: number;
  hostRootDiskPct?: number;
}

export interface FleetHost {
  instanceId: string;
  name: string;
  /** The connector's overview call succeeded (host reachable). */
  online: boolean;
  /** Error message when offline. */
  error?: string;
  metrics: FleetHostMetrics;
  stacks: FleetStack[];
}

export interface FleetTotals {
  hosts: number;
  online: number;
  running: number;
  stopped: number;
  unhealthy: number;
  stacks: number;
  updates: number;
  diskUsedGb: number;
}

export interface DockerFleet {
  hosts: FleetHost[];
  totals: FleetTotals;
}

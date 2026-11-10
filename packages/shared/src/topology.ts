/**
 * Architecture map ("topology") — one graph joined across connectors.
 *
 * The server builds it from each connector's cached resource lists plus Cerebro's own
 * data (App Replicator, Fabric), merging records that describe the same machine (by MAC,
 * then IP, then a unique hostname) and deriving the links between them. See
 * docs/architecture-map.md.
 */

/** What a node is. Drives icon, colour and which view shows it. */
export type TopoNodeType =
  | 'internet'
  | 'gateway'
  | 'switch'
  | 'ap'
  | 'network' // a VLAN / LAN
  | 'host' // any machine: VM, LXC, physical server, client device
  | 'pve_node' // Proxmox hypervisor
  | 'stack' // Docker compose project
  | 'container'
  | 'dns_name' // a hostname published by DNS / a proxy / a tunnel
  | 'proxy' // a reverse proxy (NPM instance) or tunnel (Cloudflare)
  | 'port_forward';

/** Normalised health for colouring. */
export type TopoStatus = 'ok' | 'warn' | 'down' | 'off' | 'unknown';

/** Where a node's data came from — lets the drawer link back to the connector page. */
export interface TopoSource {
  instanceId?: string;
  connectorId: string;
  /** Connector instance display name (or a module name like "App Replicator"). */
  name: string;
  kind?: string;
  resourceId?: string;
}

export interface TopoNode {
  id: string;
  type: TopoNodeType;
  label: string;
  /** Second line on the card, e.g. "VM 44104 · 192.168.44.85". */
  sublabel?: string;
  status: TopoStatus;
  /** Raw status words from the sources, e.g. "running", "online". */
  statusText?: string;
  /** Grouping parent (a network for hosts, a host for stacks, a stack for containers). */
  parent?: string;
  /** Short role chips, e.g. ["VM", "Docker host", "Fabric agent"]. */
  roles: string[];
  ips: string[];
  macs: string[];
  /** True for servers / infrastructure; false for phones, IoT and other plain clients. */
  infra: boolean;
  /**
   * What kind of device a client is ("Smart TV"), and where that came from: "You" (set in
   * Cerebro), "UniFi fingerprint", or a guess from its name or maker.
   */
  deviceType?: { name: string; model?: string; source: string };
  /** Merged key/value details from every source, grouped by source name. */
  details: { source: string; items: { label: string; value: string }[] }[];
  sources: TopoSource[];
}

export type TopoEdgeType =
  | 'uplink' // physical: device → upstream switch / AP / gateway
  | 'runs_on' // VM → hypervisor
  | 'hosts' // host → stack, stack → container (also implied by parent)
  | 'routes' // gateway → network
  | 'forwards' // proxy / tunnel / port forward → target host or container
  | 'resolves' // DNS name → proxy or host
  | 'fw_allow' // firewall allow between two endpoints
  | 'fw_block';

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  type: TopoEdgeType;
  label?: string;
  /** Extra lines for the edge tooltip / drawer, e.g. the firewall rule name. */
  notes?: string[];
}

/** One connector (or module) that fed this build, and whether it worked. */
export interface TopoFeed {
  name: string;
  connectorId: string;
  instanceId?: string;
  ok: boolean;
  message?: string;
}

export interface TopologyGraph {
  generatedAt: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
  feeds: TopoFeed[];
  /** Security posture findings, worst first (see docs/architecture-map.md#posture-findings). */
  findings?: PostureFinding[];
  /** What the outside-in checks saw (absent when they're switched off). */
  outsideIn?: OutsideInSummary;
  /** Container image CVE scan status. */
  imageScan?: ImageScanSummary;
  /** DNS-over-HTTPS resolver used to check whether names are public. */
  publicDnsResolver?: string;
  /** Every way in from the internet and what it reaches (see docs/architecture-map.md#exposure-paths). */
  exposure?: ExposureEntry[];
}

/** A finding as it shows on one hop of an exposure path. */
export interface ExposureFlag {
  findingId: string;
  severity: PostureSeverity;
  category: PostureCategory;
  title: string;
  /** Set when the finding is on what the hop runs on (its VM, say), not the hop itself. */
  on?: string;
}

/** One step on the way in: a proxy, a public name, a container or host. */
export interface ExposureHop {
  nodeId: string;
  label: string;
  /** e.g. "→ :6789" for the proxy's forward. */
  via?: string;
  flags: ExposureFlag[];
}

/** One way in → one destination. */
export interface ExposurePath {
  id: string;
  hops: ExposureHop[];
  /** Worst flag on the path; "none" when nothing is flagged. */
  severity: PostureSeverity | 'none';
  /** e.g. "password login (access list Staff)", "not in public DNS". */
  notes?: string[];
  /** The public name on this path (for "Treat as internal"). */
  name?: string;
}

/** A way in from the internet: a set of forwarded WAN ports to one machine, or a Cloudflare tunnel. */
export interface ExposureEntry {
  id: string;
  kind: 'port_forward' | 'tunnel';
  /** "WAN :80, :443" or "Cloudflare tunnel home". */
  label: string;
  /** What the entry lands on first (the proxy, or the forwarded machine). */
  nodeId?: string;
  /** e.g. 'from any source', the port forward names. */
  notes: string[];
  paths: ExposurePath[];
  severity: PostureSeverity | 'none';
  /** Names left out because they're LAN-only or you marked them internal (the latter can be undone). */
  hidden?: { name: string; reason: 'lan' | 'marked' }[];
}

/** Status of the container image CVE scan (Trivy). */
export interface ImageScanSummary {
  enabled: boolean;
  /** False when Trivy isn't installed in this Cerebro image. */
  available: boolean;
  running: boolean;
  progress?: { done: number; total: number };
  lastRunAt?: string;
  scanned: number;
  failed: number;
}

/** Outside-in checks: public data about your WAN address and software versions. */
export interface OutsideInSummary {
  enabled: boolean;
  /** Per WAN address: what Shodan's InternetDB last saw. */
  wan: { ip: string; ports: number[]; hostnames: string[]; vulns: string[]; tags: string[]; checkedAt: string }[];
  /** Sources that couldn't be reached this time (last good data is still used). */
  errors: string[];
}

export type PostureSeverity = 'high' | 'medium' | 'low';
export type PostureCategory = 'exposure' | 'encryption' | 'backups' | 'patching' | 'hygiene';

/** One thing worth fixing, computed from what the connectors already report. */
export interface PostureFinding {
  /** Stable across rebuilds, e.g. "npm-http:<instanceId>"; snoozes key on it. */
  id: string;
  severity: PostureSeverity;
  category: PostureCategory;
  title: string;
  /** Why it matters, one or two sentences. */
  why: string;
  /** What to do about it. */
  fix: string;
  /** What it's about; nodeId links to the map when the item is on it. */
  /** nodeId links to the map; url (outside-in findings) opens the evidence, e.g. the page or Shodan's record. */
  affected: PostureAffected[];
  /** Other map items that should carry this finding's badge (e.g. the Internet tile for a port forward). */
  alsoOn?: string[];
  /** Where the data came from, e.g. "Nginx Proxy Manager", "UniFi". */
  source: string;
  /** Set while every item is snoozed: ISO time the first one wakes up again. */
  snoozedUntil?: string;
  /** Tracking (Posture page). Open while any item is open; fixed ones come from GET /api/posture/fixed. */
  status?: PostureStatus;
  /** When Cerebro first found it (absent until it has been recorded). */
  firstSeenAt?: string;
  /** Set on a fixed finding: when a build stopped finding it. */
  resolvedAt?: string;
  /** Machines involved (host / VM / gateway labels), for filtering and grouping by host. */
  hosts?: string[];
}

export type PostureStatus = 'open' | 'snoozed' | 'accepted' | 'fixed';

/** One thing a finding is about, and what you decided about it. */
export interface PostureAffected {
  label: string;
  nodeId?: string;
  note?: string;
  url?: string;
  /** Absent or "open" unless snoozed / accepted. */
  status?: 'open' | 'snoozed' | 'accepted';
  /** Snoozed (or accepted) until; absent on an accepted item means until something changes. */
  until?: string;
  /** Why the risk was accepted. */
  reason?: string;
  setBy?: string;
  setAt?: string;
  firstSeenAt?: string;
}

/** One line of a finding's history. */
export interface PostureEventView {
  at: string;
  kind: string;
  text: string;
  actor?: string;
}

/** One step of a map build, for the "Checking your connectors" view. */
export interface TopologyStep {
  key: string;
  label: string;
  /** Connector id ("unifi", "proxmox"…) or "check" for Cerebro's own checks. */
  kind: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  /** e.g. "81 clients, 6 devices" or the error. */
  detail?: string;
}

/** GET /api/topology/progress: the build that's running (or the last one). */
export interface TopologyProgress {
  running: boolean;
  /** True when it re-reads everything live (Check now / Refresh). */
  refresh: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** How long the previous build took, to estimate this one. */
  lastDurationMs?: number;
  steps: TopologyStep[];
}

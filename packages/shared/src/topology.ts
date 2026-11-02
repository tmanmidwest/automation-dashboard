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
  affected: { label: string; nodeId?: string; note?: string; url?: string }[];
  /** Other map items that should carry this finding's badge (e.g. the Internet tile for a port forward). */
  alsoOn?: string[];
  /** Where the data came from, e.g. "Nginx Proxy Manager", "UniFi". */
  source: string;
  /** Set while snoozed: ISO time it wakes up again. */
  snoozedUntil?: string;
}

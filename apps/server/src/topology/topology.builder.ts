import type {
  ConnectorResource,
  TopoEdge,
  TopoEdgeType,
  TopoFeed,
  TopoNode,
  TopoSource,
  TopoStatus,
  TopologyGraph,
} from '@cerebro/shared';

/**
 * Pure graph builder for the architecture map. The service gathers raw connector
 * resources; this file turns them into one graph:
 *
 *  1. every record that describes a machine becomes an "observation" (MACs, IPs, names);
 *  2. observations that share a MAC or IP (or, failing that, one unique hostname) are
 *     merged into one host node;
 *  3. hosts are placed in the UniFi network whose subnet holds their IP;
 *  4. links are derived: physical uplinks, VM → hypervisor, host → stack → container,
 *     DNS / proxy / tunnel / port forward → target, and firewall allow/block rules.
 *
 * No I/O here, so it can be exercised with captured data.
 */

// ── inputs ─────────────────────────────────────────────────────────────────

export interface InstRef {
  id: string;
  name: string;
}

export interface BuildInput {
  unifi: {
    inst: InstRef;
    devices: ConnectorResource[];
    clients: ConnectorResource[];
    networks: ConnectorResource[];
    portForwards: ConnectorResource[];
    firewallRules: ConnectorResource[];
  }[];
  proxmox: { inst: InstRef; baseHost: string | null; guests: ConnectorResource[] }[];
  docker: { inst: InstRef; endpointHost: string | null; hosts: ConnectorResource[]; containers: ConnectorResource[] }[];
  npm: { inst: InstRef; baseHost: string | null; basePort?: string | null; proxyHosts: ConnectorResource[]; certificates?: ConnectorResource[]; accessLists?: ConnectorResource[] }[];
  technitium: { inst: InstRef; baseHost: string | null; records: { zone: string; record: ConnectorResource }[]; leases: ConnectorResource[] }[];
  cloudflare: { inst: InstRef; tunnels: { tunnel: ConnectorResource; routes: ConnectorResource[] }[] }[];
  replicator: { name: string; appName: string; project: string; dockerInstanceId: string; status: string }[];
  fabric: { id: string; name: string; hostname: string | null; localIp: string | null; online: boolean; mode: string }[];
  /** Proxmox backup files (Backblaze connector's local vzdump list); only used for posture findings. */
  backups?: { inst: InstRef; files: ConnectorResource[] }[];
  feeds: TopoFeed[];
  now?: Date;
}

// ── small helpers ─────────────────────────────────────────────────────────

const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/g;
const IPV4_CIDR = /\b(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})\b/g;
const MAC = /\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/gi;

function ipToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

interface Cidr {
  base: number;
  mask: number;
  bits: number;
}

function parseCidr(s: string): Cidr | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const bits = Number(m[2]);
  if (ip == null || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, mask, bits };
}

function inCidr(ip: string, c: Cidr): boolean {
  const n = ipToInt(ip);
  return n != null && ((n & c.mask) >>> 0) === c.base;
}

function isPrivate(ip: string): boolean {
  const n = ipToInt(ip);
  if (n == null) return false;
  return (
    inCidr(ip, parseCidr('10.0.0.0/8')!) ||
    inCidr(ip, parseCidr('172.16.0.0/12')!) ||
    inCidr(ip, parseCidr('192.168.0.0/16')!) ||
    inCidr(ip, parseCidr('100.64.0.0/10')!)
  );
}

function ipsIn(s: unknown): string[] {
  if (s == null) return [];
  return [...String(s).matchAll(IPV4)].map((m) => m[1]).filter((ip) => ipToInt(ip) != null);
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** "ubuDocker02.lab.local" → "ubudocker02"; used only for the last-resort name join. */
function normName(s: string): string {
  return s.trim().toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
}

function statusOf(raw: string | null | undefined): TopoStatus {
  const s = (raw ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/unhealthy|restarting|degraded|warn|pending|upgrad|adopting|provision/.test(s)) return 'warn';
  if (/^(running|online|up|active|enabled|connected|healthy|ok|proxied|dns_only|healthy)$/.test(s) || s.startsWith('up ')) return 'ok';
  if (/stopped|exited|created|paused|disabled|off|template/.test(s)) return 'off';
  if (/offline|down|dead|error|fail|disconnected|unreachable|expired/.test(s)) return 'down';
  return 'unknown';
}

const STATUS_RANK: Record<TopoStatus, number> = { down: 4, warn: 3, ok: 2, off: 1, unknown: 0 };

const ACRONYMS: Record<string, string> = { ip: 'IP', mac: 'MAC', vlan: 'VLAN', ssid: 'SSID', cpu: 'CPU', dns: 'DNS', id: 'ID' };

/** "firstSeen" / "fixed_ip" → "First seen" / "Fixed IP". */
function detailLabel(k: string): string {
  const words = k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
  const out = words.map((w) => ACRONYMS[w] ?? w).join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function detailItems(d: ConnectorResource['details'], skip: string[] = []): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [k, v] of Object.entries(d ?? {})) {
    if (v == null || v === '' || skip.includes(k)) continue;
    out.push({ label: detailLabel(k), value: String(v) });
  }
  return out;
}

// ── observations + merge ──────────────────────────────────────────────────

interface Obs {
  key: string;
  deviceType?: TopoNode['deviceType'];
  names: string[];
  macs: string[];
  ips: string[];
  /** Label priority: lower wins. */
  prio: number;
  label: string;
  roles: string[];
  infra: boolean;
  status?: TopoStatus;
  statusText?: string;
  /** Only join an existing machine; never create a node on its own. */
  attachOnly?: boolean;
  networkName?: string;
  vlan?: string;
  sublabel?: string;
  details?: { source: string; items: { label: string; value: string }[] };
  source?: TopoSource;
}

class UnionFind {
  private p = new Map<string, string>();
  find(a: string): string {
    let r = a;
    while (this.p.has(r) && this.p.get(r) !== r) r = this.p.get(r)!;
    let c = a;
    while (this.p.has(c) && this.p.get(c) !== r) {
      const n = this.p.get(c)!;
      this.p.set(c, r);
      c = n;
    }
    if (!this.p.has(r)) this.p.set(r, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

// ── builder ───────────────────────────────────────────────────────────────

export function buildTopology(input: BuildInput): TopologyGraph {
  const nodes = new Map<string, TopoNode>();
  const edges = new Map<string, TopoEdge>();
  const now = input.now ?? new Date();

  const addNode = (n: TopoNode) => {
    const prev = nodes.get(n.id);
    if (!prev) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };
  const addEdge = (source: string, target: string, type: TopoEdgeType, label?: string, note?: string) => {
    if (!source || !target || source === target) return;
    const id = `${type}:${source}>${target}`;
    const prev = edges.get(id);
    if (prev) {
      if (note && !prev.notes?.includes(note)) prev.notes = [...(prev.notes ?? []), note];
      return;
    }
    edges.set(id, { id, source, target, type, label, notes: note ? [note] : undefined });
  };

  addNode({ id: 'internet', type: 'internet', label: 'Internet', status: 'ok', roles: [], ips: [], macs: [], infra: true, details: [], sources: [] });

  // 1. Networks (UniFi LANs / VLANs)
  const networks: { id: string; name: string; cidr: Cidr; vlan: string | null }[] = [];
  for (const u of input.unifi) {
    for (const n of u.networks) {
      const subnet = str(n.details?.subnet);
      if (!subnet || String(n.details?.purpose ?? '') === 'wan') continue;
      const cidr = parseCidr(subnet);
      if (!cidr) continue;
      const cidrText = `${[24, 16, 8, 0].map((sh) => (cidr.base >>> sh) & 255).join('.')}/${cidr.bits}`;
      const id = `net:${cidrText}`;
      const vlan = str(n.details?.vlan);
      networks.push({ id, name: n.name, cidr, vlan });
      addNode({
        id,
        type: 'network',
        label: n.name,
        sublabel: `${cidrText}${vlan ? ` · VLAN ${vlan}` : ' · untagged'}`,
        status: statusOf(n.status),
        statusText: n.status,
        roles: [String(n.details?.purpose ?? 'network')],
        ips: [],
        macs: [],
        infra: true,
        details: [{ source: u.inst.name, items: detailItems(n.details) }],
        sources: [{ instanceId: u.inst.id, connectorId: 'unifi', name: u.inst.name, kind: 'network', resourceId: n.id }],
      });
    }
  }
  const networkForIp = (ip: string) => networks.find((n) => inCidr(ip, n.cidr));
  const networkByName = (name: string) => networks.find((n) => n.name.toLowerCase() === name.trim().toLowerCase());
  const networkByVlan = (vlan: string) => networks.find((n) => n.vlan === vlan);
  /** IPs worth matching on: inside a known LAN (or any private IP when we know no LANs), never docker bridges. */
  const matchable = (ip: string) => {
    if (!isPrivate(ip) || ip.startsWith('127.')) return false;
    if (networks.length) return !!networkForIp(ip);
    return !/^172\.(1[7-9]|2\d|3[01])\./.test(ip);
  };

  // 2. UniFi devices (gateway / switches / APs) — fixed nodes, also claim their MAC/IP.
  const deviceByName = new Map<string, string>();
  const claimed = new Map<string, string>(); // mac/ip → device node id
  for (const u of input.unifi) {
    for (const d of u.devices) {
      const t = String(d.details?.type ?? d.tags?.type ?? '').toLowerCase();
      const type = t.includes('gateway') ? 'gateway' : t.includes('access') ? 'ap' : 'switch';
      const id = `dev:${d.id.toLowerCase()}`;
      const ip = str(d.details?.ip);
      addNode({
        id,
        type,
        label: d.name,
        sublabel: [str(d.details?.model), type === 'gateway' ? null : ip].filter(Boolean).join(' · '),
        status: statusOf(d.status),
        statusText: d.status,
        roles: [String(d.details?.type ?? type)],
        ips: ip ? [ip] : [],
        macs: [d.id.toLowerCase()],
        infra: true,
        details: [{ source: u.inst.name, items: detailItems(d.details) }],
        sources: [{ instanceId: u.inst.id, connectorId: 'unifi', name: u.inst.name, kind: 'device', resourceId: d.id }],
      });
      deviceByName.set(d.name.toLowerCase(), id);
      claimed.set(d.id.toLowerCase(), id);
      if (ip) claimed.set(ip, id);
      if (type === 'gateway') {
        addEdge(id, 'internet', 'uplink', 'WAN');
        for (const n of networks) {
          // The gateway owns each LAN's .1-style address (the subnet string's host part).
          addEdge(id, n.id, 'routes');
        }
      }
    }
    for (const n of u.networks) {
      const gw = str(n.details?.subnet)?.split('/')[0];
      const gwNode = [...nodes.values()].find((x) => x.type === 'gateway');
      if (gw && gwNode) claimed.set(gw, gwNode.id);
    }
  }
  const deviceForVia = (via: string | null): { id: string; port?: string } | null => {
    if (!via) return null;
    const m = /^(.*?)(?:\s+port\s+(\S+))?$/i.exec(via.trim());
    const id = m ? deviceByName.get(m[1].toLowerCase()) : undefined;
    return id ? { id, port: m?.[2] } : null;
  };
  for (const u of input.unifi) {
    for (const d of u.devices) {
      const up = deviceForVia(str(d.details?.uplink));
      if (up) addEdge(`dev:${d.id.toLowerCase()}`, up.id, 'uplink', up.port ? `port ${up.port}` : undefined);
    }
  }

  // 3. Observations of machines from every source.
  const obs: Obs[] = [];
  const uplinkOf = new Map<string, { id: string; port?: string }>(); // obs key → device

  for (const u of input.unifi) {
    for (const c of u.clients) {
      const mac = str(c.details?.mac)?.toLowerCase();
      const ip = str(c.details?.ip);
      const key = `unifi:${u.inst.id}:${c.id}`;
      obs.push({
        key,
        names: [c.name],
        macs: mac ? [mac] : [],
        ips: ip ? [ip] : [],
        prio: 50,
        label: c.name,
        roles: [],
        infra: false,
        status: statusOf(c.status),
        statusText: c.status,
        networkName: c.tags?.network,
        details: { source: u.inst.name, items: detailItems(c.details, ['up', 'down', 'deviceType', 'deviceModel', 'typeFrom', 'firstSeenAt']) },
        source: { instanceId: u.inst.id, connectorId: 'unifi', name: u.inst.name, kind: 'client', resourceId: c.id },
        deviceType: str(c.details?.deviceType)
          ? { name: str(c.details?.deviceType)!, model: str(c.details?.deviceModel) ?? undefined, source: str(c.details?.typeFrom) ?? 'Guess' }
          : undefined,
      });
      const up = deviceForVia(str(c.details?.via));
      if (up) uplinkOf.set(key, up);
    }
  }

  // Proxmox: guests + their hypervisor nodes.
  const pveNodeKeys = new Map<string, string>(); // `${inst}:${node}` → obs key
  for (const p of input.proxmox) {
    const nodeNames = [...new Set(p.guests.map((g) => str(g.details?.node)).filter(Boolean) as string[])];
    for (const nn of nodeNames) {
      const key = `pve:${p.inst.id}:${nn}`;
      pveNodeKeys.set(`${p.inst.id}:${nn}`, key);
      const baseIp = p.baseHost && ipToInt(p.baseHost) != null ? p.baseHost : null;
      obs.push({
        key,
        names: [nn, ...(p.baseHost && !baseIp && nodeNames.length === 1 ? [p.baseHost] : [])],
        macs: [],
        // With a single node, the API address is that node.
        ips: baseIp && nodeNames.length === 1 ? [baseIp] : [],
        prio: 15,
        label: nn,
        roles: ['Proxmox node'],
        infra: true,
        status: 'ok',
        details: { source: p.inst.name, items: [{ label: 'Node', value: nn }, { label: 'Guests', value: String(p.guests.filter((g) => g.details?.node === nn).length) }] },
        source: { instanceId: p.inst.id, connectorId: 'proxmox', name: p.inst.name },
      });
    }
    for (const g of p.guests) {
      const mac = str(g.details?.mac)?.toLowerCase();
      const isLxc = g.kind === 'lxc';
      obs.push({
        key: `pveguest:${p.inst.id}:${g.id}`,
        names: [g.name],
        macs: mac ? [mac] : [],
        ips: ipsIn(g.details?.ip),
        prio: 10,
        label: g.name,
        roles: [isLxc ? 'LXC' : 'VM'],
        infra: true,
        status: statusOf(g.status),
        statusText: g.status,
        vlan: str(g.details?.vlan) ?? undefined,
        sublabel: `${isLxc ? 'CT' : 'VM'} ${g.id}`,
        details: { source: p.inst.name, items: detailItems(g.details, ['ip']) },
        source: { instanceId: p.inst.id, connectorId: 'proxmox', name: p.inst.name, kind: g.kind, resourceId: g.id },
      });
    }
  }

  // Docker hosts.
  for (const d of input.docker) {
    const h = d.hosts[0];
    const ep = d.endpointHost;
    const epIp = ep && ipToInt(ep) != null ? ep : null;
    obs.push({
      key: `docker:${d.inst.id}`,
      names: [h?.name, ep && !epIp ? ep : null].filter(Boolean) as string[],
      macs: [],
      ips: epIp ? [epIp] : [],
      prio: 20,
      label: h?.name ?? d.inst.name,
      roles: ['Docker host'],
      infra: true,
      status: h ? statusOf(h.status) : 'unknown',
      statusText: h?.status,
      details: h ? { source: d.inst.name, items: detailItems(h.details) } : undefined,
      source: { instanceId: d.inst.id, connectorId: 'docker', name: d.inst.name, kind: 'docker_host', resourceId: h?.id },
    });
  }

  // Fabric agents.
  for (const a of input.fabric) {
    obs.push({
      key: `fabric:${a.id}`,
      names: [a.hostname, a.name].filter(Boolean) as string[],
      macs: [],
      ips: a.localIp ? [a.localIp] : [],
      prio: 30,
      label: a.hostname || a.name,
      roles: ['Fabric agent'],
      infra: true,
      status: a.online ? 'ok' : 'down',
      statusText: a.online ? 'online' : 'offline',
      details: { source: 'Fabric', items: [{ label: 'Agent', value: a.name }, { label: 'Mode', value: a.mode }, { label: 'Local IP', value: a.localIp ?? '—' }] },
      source: { connectorId: 'fabric', name: 'Fabric' },
    });
  }

  // Service endpoints Cerebro talks to (NPM, Technitium): mark the host they run on.
  const serviceObs = (key: string, host: string | null, role: string, inst: InstRef, connectorId: string) => {
    if (!host) return;
    const ip = ipToInt(host) != null ? host : null;
    obs.push({
      key,
      names: ip ? [] : [host],
      macs: [],
      ips: ip ? [ip] : [],
      prio: 40,
      label: host,
      roles: [role],
      infra: true,
      details: { source: inst.name, items: [{ label: 'Service', value: role }, { label: 'Address', value: host }] },
      source: { instanceId: inst.id, connectorId, name: inst.name },
    });
  };
  for (const n of input.npm) serviceObs(`npmsvc:${n.inst.id}`, n.baseHost, 'Reverse proxy (NPM)', n.inst, 'nginx-proxy-manager');
  for (const t of input.technitium) serviceObs(`dnssvc:${t.inst.id}`, t.baseHost, 'DNS server (Technitium)', t.inst, 'technitium');

  // DHCP leases: only enrich machines we already know (names + MAC↔IP pairs).
  for (const t of input.technitium) {
    for (const l of t.leases) {
      const mac = str(l.details?.mac)?.toLowerCase().replace(/-/g, ':');
      const ip = str(l.details?.address);
      obs.push({
        key: `lease:${t.inst.id}:${l.id}`,
        names: l.name && l.name !== ip ? [l.name] : [],
        macs: mac ? [mac] : [],
        ips: ip ? [ip] : [],
        prio: 60,
        label: l.name,
        roles: [],
        infra: false,
        attachOnly: true,
        details: { source: `${t.inst.name} (DHCP)`, items: detailItems(l.details) },
        source: { instanceId: t.inst.id, connectorId: 'technitium', name: t.inst.name, kind: 'dhcp_lease', resourceId: l.id },
      });
    }
  }

  // Merge: MAC and in-LAN IP join observations; device-claimed addresses are skipped.
  const uf = new UnionFind();
  const byKey = new Map<string, string>(); // "mac:..."/"ip:..." → first obs key
  for (const o of obs) {
    uf.find(o.key);
    const keys = [...o.macs.map((m) => `mac:${m}`), ...o.ips.filter((ip) => matchable(ip) && !claimed.has(ip)).map((ip) => `ip:${ip}`)];
    for (const k of keys) {
      if (claimed.has(k.slice(k.indexOf(':') + 1))) continue;
      const prev = byKey.get(k);
      if (prev) uf.union(prev, o.key);
      else byKey.set(k, o.key);
    }
  }
  // Last resort: join by a hostname that exactly one other group carries.
  const groupsByName = new Map<string, Set<string>>();
  for (const o of obs) for (const n of o.names) {
    const k = normName(n);
    if (!k) continue;
    if (!groupsByName.has(k)) groupsByName.set(k, new Set());
    groupsByName.get(k)!.add(uf.find(o.key));
  }
  for (const o of obs) {
    const own = uf.find(o.key);
    const hasAddr = o.macs.length > 0 || o.ips.some(matchable);
    for (const n of o.names) {
      const others = [...(groupsByName.get(normName(n)) ?? [])].map((g) => uf.find(g)).filter((g) => g !== own);
      const distinct = [...new Set(others)];
      // Only join when unambiguous, and don't override an address match for addressable records.
      if (distinct.length === 1 && (!hasAddr || o.prio <= 20)) {
        const otherObs = obs.filter((x) => uf.find(x.key) === distinct[0]);
        const conflict = hasAddr && otherObs.some((x) => x.macs.length && o.macs.length && !x.macs.some((m) => o.macs.includes(m)));
        if (!conflict) uf.union(distinct[0], o.key);
        break;
      }
    }
  }

  // Build host nodes from groups.
  const groups = new Map<string, Obs[]>();
  for (const o of obs) {
    const r = uf.find(o.key);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(o);
  }
  const hostOfObs = new Map<string, string>(); // obs key → host node id
  const hostByIp = new Map<string, string>();
  const hostByMac = new Map<string, string>();
  let hostSeq = 0;
  for (const members of groups.values()) {
    if (members.every((m) => m.attachOnly)) continue;
    members.sort((a, b) => a.prio - b.prio);
    // The label comes from the best-ranked source that has a real name (not just an address).
    const lead = members.find((m) => m.label && ipToInt(m.label) == null && !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(m.label)) ?? members[0];
    const macs = [...new Set(members.flatMap((m) => m.macs))];
    const allIps = [...new Set(members.flatMap((m) => m.ips))];
    // Hide docker-bridge / loopback noise from guest-agent IP lists when a LAN address exists.
    const lanIps = allIps.filter(matchable);
    const ips = lanIps.length ? [...lanIps, ...allIps.filter((ip) => !matchable(ip) && !/^172\.(1[6-9]|2\d|3[01])\.\d+\.1$/.test(ip) && !ip.startsWith('127.'))] : allIps;
    const primaryIp = ips.find(matchable) ?? ips.find((ip) => isPrivate(ip) && !ip.startsWith('172.')) ?? ips[0];
    const id = macs[0] ? `host:${macs[0]}` : primaryIp ? `host:${primaryIp}` : `host:${normName(lead.label) || ++hostSeq}`;
    const statuses = members.filter((m) => m.status && m.status !== 'unknown').map((m) => m.status!) as TopoStatus[];
    // A VM's own state wins (a stopped VM is "off" even if UniFi still lists it); else worst of the rest.
    const vmStatus = members.find((m) => m.roles.includes('VM') || m.roles.includes('LXC'))?.status;
    const status: TopoStatus = vmStatus ?? (statuses.sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? 'unknown');
    let net = primaryIp ? networkForIp(primaryIp) : undefined;
    if (!net) for (const m of members) {
      if (!net && m.networkName) net = networkByName(m.networkName);
      if (!net && m.vlan) net = networkByVlan(m.vlan);
    }
    const roles = [...new Set(members.flatMap((m) => m.roles))];
    const sub = [members.find((m) => m.sublabel)?.sublabel, primaryIp].filter(Boolean).join(' · ');
    addNode({
      id,
      type: roles.includes('Proxmox node') ? 'pve_node' : 'host',
      label: lead.label,
      sublabel: sub || undefined,
      status,
      statusText: members.find((m) => m.statusText)?.statusText,
      parent: net?.id,
      roles,
      ips,
      macs,
      infra: members.some((m) => m.infra && !m.attachOnly),
      deviceType: members.find((m) => m.deviceType)?.deviceType,
      details: members.filter((m) => m.details).map((m) => m.details!),
      sources: members.filter((m) => m.source).map((m) => m.source!),
    });
    for (const m of members) hostOfObs.set(m.key, id);
    for (const ip of ips) if (!hostByIp.has(ip)) hostByIp.set(ip, id);
    for (const mac of macs) if (!hostByMac.has(mac)) hostByMac.set(mac, id);
  }

  /** Find (or create a bare node for) the machine at an IP, for link targets. */
  const hostForIp = (ip: string, hint?: string): string | null => {
    const known = hostByIp.get(ip) ?? claimed.get(ip);
    if (known) return known;
    if (!isPrivate(ip)) return null;
    const id = `host:${ip}`;
    addNode({
      id,
      type: 'host',
      label: ip,
      sublabel: hint ?? 'Not seen by any connector',
      status: 'unknown',
      parent: networkForIp(ip)?.id,
      roles: [],
      ips: [ip],
      macs: [],
      infra: true,
      details: [],
      sources: [],
    });
    hostByIp.set(ip, id);
    return id;
  };

  // Physical attachment of hosts (client → switch port / AP) — kept as edges for the drawer.
  for (const [key, up] of uplinkOf) {
    const h = hostOfObs.get(key);
    if (h) addEdge(h, up.id, 'uplink', up.port ? `port ${up.port}` : 'Wi-Fi');
  }
  // VM → hypervisor.
  for (const p of input.proxmox) for (const g of p.guests) {
    const vm = hostOfObs.get(`pveguest:${p.inst.id}:${g.id}`);
    const pk = pveNodeKeys.get(`${p.inst.id}:${str(g.details?.node)}`);
    const pv = pk ? hostOfObs.get(pk) : undefined;
    if (vm && pv) addEdge(vm, pv, 'runs_on');
  }

  // 4. Docker stacks + containers, under their host.
  const portOwners = new Map<string, string>(); // `${hostId}:${publicPort}` → container node
  for (const d of input.docker) {
    const hostId = hostOfObs.get(`docker:${d.inst.id}`);
    if (!hostId) continue;
    const stacks = new Map<string, ConnectorResource[]>();
    for (const c of d.containers) {
      const s = str(c.details?.stack) ?? '(no stack)';
      if (!stacks.has(s)) stacks.set(s, []);
      stacks.get(s)!.push(c);
    }
    for (const [stackName, cs] of stacks) {
      const sid = `stack:${d.inst.id}:${stackName}`;
      const rep = input.replicator.find((r) => r.dockerInstanceId === d.inst.id && r.project === stackName);
      const st = cs.map((c) => containerStatus(c)).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] ?? 'unknown';
      addNode({
        id: sid,
        type: 'stack',
        label: stackName,
        sublabel: `${cs.length} container${cs.length === 1 ? '' : 's'}`,
        status: st,
        parent: hostId,
        roles: rep ? [`Replicator: ${rep.appName}`] : [],
        ips: [],
        macs: [],
        infra: true,
        details: [
          { source: d.inst.name, items: [{ label: 'Containers', value: String(cs.length) }, { label: 'Running', value: String(cs.filter((c) => c.status === 'running').length) }] },
          ...(rep ? [{ source: 'App Replicator', items: [{ label: 'App', value: rep.appName }, { label: 'Deployment', value: rep.name }, { label: 'Status', value: rep.status }] }] : []),
        ],
        sources: [
          { instanceId: d.inst.id, connectorId: 'docker', name: d.inst.name, kind: 'stack', resourceId: stackName },
          ...(rep ? [{ connectorId: 'replicator', name: 'App Replicator' }] : []),
        ],
      });
      for (const c of cs) {
        const cid = `ctr:${d.inst.id}:${c.id.slice(0, 12)}`;
        const ports = str(c.details?.ports);
        addNode({
          id: cid,
          type: 'container',
          label: str(c.details?.service) ?? c.name,
          sublabel: str(c.details?.image) ?? undefined,
          status: containerStatus(c),
          statusText: str(c.details?.status_text) ?? c.status,
          parent: sid,
          roles: c.tags?.updates === 'available' ? ['Image update'] : [],
          ips: [],
          macs: [],
          infra: true,
          details: [{ source: d.inst.name, items: detailItems(c.details) }],
          sources: [{ instanceId: d.inst.id, connectorId: 'docker', name: d.inst.name, kind: 'container', resourceId: c.id }],
        });
        for (const m of (ports ?? '').matchAll(/(\d+)→\d+/g)) portOwners.set(`${hostId}:${m[1]}`, cid);
      }
    }
  }

  /** Target for "something forwards to ip:port": the container publishing that port, else the host. */
  const targetFor = (ip: string, port?: string | null): string | null => {
    const h = hostForIp(ip);
    if (!h) return null;
    return (port && portOwners.get(`${h}:${port}`)) || h;
  };
  const dnsNode = (fqdn: string, src: TopoSource, detail?: { source: string; items: { label: string; value: string }[] }) => {
    const id = `dns:${fqdn.toLowerCase()}`;
    const n = addNode({ id, type: 'dns_name', label: fqdn.toLowerCase(), status: 'ok', roles: [], ips: [], macs: [], infra: true, details: [], sources: [] });
    if (!n.sources.some((s) => s.instanceId === src.instanceId && s.resourceId === src.resourceId)) n.sources.push(src);
    if (detail) n.details.push(detail);
    return id;
  };

  // 5. Reverse proxy hosts (NPM): name → proxy host → target.
  for (const n of input.npm) {
    // The proxy itself: the container publishing NPM's admin port on that host, else the host.
    const proxyHost = n.baseHost && ipToInt(n.baseHost) != null ? targetFor(n.baseHost, n.basePort ?? null) : null;
    for (const p of n.proxyHosts) {
      const fwd = str(p.details?.forward);
      const m = fwd ? /^\w+:\/\/([^/:]+)(?::(\d+))?/.exec(fwd) : null;
      const names = (str(p.details?.domains) ?? p.name).split(/[,\s]+/).filter(Boolean);
      for (const name of names) {
        const id = dnsNode(name, { instanceId: n.inst.id, connectorId: 'nginx-proxy-manager', name: n.inst.name, kind: 'proxy_host', resourceId: p.id }, { source: n.inst.name, items: detailItems(p.details) });
        const node = nodes.get(id)!;
        node.status = statusOf(p.status);
        node.roles = [...new Set([...node.roles, 'NPM proxy host'])];
        if (proxyHost) addEdge(id, proxyHost, 'resolves', 'served by NPM');
        if (m) {
          const tgt = ipToInt(m[1]) != null ? targetFor(m[1], m[2]) : null;
          if (tgt) addEdge(proxyHost ?? id, tgt, 'forwards', `${name} → :${m[2] ?? 80}`, `NPM: ${name} → ${fwd}`);
        }
      }
    }
  }

  // 6. Cloudflare tunnels: public hostname → internal service.
  for (const cf of input.cloudflare) {
    for (const { tunnel, routes } of cf.tunnels) {
      for (const r of routes) {
        const hostname = str(r.details?.hostname);
        const service = str(r.details?.service);
        if (!hostname) continue;
        const id = dnsNode(hostname, { instanceId: cf.inst.id, connectorId: 'cloudflare', name: cf.inst.name, kind: 'tunnel', resourceId: tunnel.id }, { source: `${cf.inst.name} · tunnel ${tunnel.name}`, items: detailItems(r.details) });
        const node = nodes.get(id)!;
        node.roles = [...new Set([...node.roles, 'Cloudflare tunnel'])];
        addEdge('internet', id, 'resolves', `tunnel ${tunnel.name}`);
        const m = service ? /^\w+:\/\/([^/:]+)(?::(\d+))?/.exec(service) : null;
        if (m) {
          const tgt = ipToInt(m[1]) != null ? targetFor(m[1], m[2]) : null;
          if (tgt) addEdge(id, tgt, 'forwards', m[2] ? `:${m[2]}` : undefined, `Tunnel ${tunnel.name}: ${hostname} → ${service}`);
        }
      }
    }
  }

  // 7. Internal DNS (Technitium A records pointing into the LAN).
  for (const t of input.technitium) {
    for (const { zone, record } of t.records) {
      const m = /^A\s·\s(.+)$/.exec(record.name);
      if (!m || record.status === 'disabled') continue;
      const ip = ipsIn(record.details?.value)[0];
      if (!ip || !matchable(ip)) continue;
      const fqdn = m[1];
      const id = dnsNode(fqdn, { instanceId: t.inst.id, connectorId: 'technitium', name: t.inst.name, kind: 'zone', resourceId: zone }, { source: `${t.inst.name} · ${zone}`, items: [{ label: 'A', value: ip }] });
      const node = nodes.get(id)!;
      node.roles = [...new Set([...node.roles, 'DNS record'])];
      const h = hostForIp(ip);
      if (h) addEdge(id, h, 'resolves', ip);
    }
  }

  // 8. UniFi port forwards (Internet exposure) and firewall rules.
  let ipsDenied = 0;
  for (const u of input.unifi) {
    for (const pf of u.portForwards) {
      if (statusOf(pf.status) === 'off') continue;
      const to = str(pf.details?.forwardTo);
      const m = to ? /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/.exec(to) : null;
      if (!m) continue;
      const tgt = targetFor(m[1], m[2]);
      if (tgt) addEdge('internet', tgt, 'forwards', `WAN :${pf.details?.port ?? '?'} → :${m[2] ?? '?'}`, `Port forward "${pf.name}" (${pf.details?.protocol ?? 'tcp'}, from ${pf.details?.from ?? 'any'})`);
    }
    for (const r of u.firewallRules) {
      const status = String(r.status ?? '').toLowerCase();
      if (status === 'disabled') continue;
      if (/^IPS Deny List/i.test(r.name)) { ipsDenied++; continue; }
      const src = str(r.details?.source) ?? 'any';
      const dst = str(r.details?.destination) ?? 'any';
      if (src === 'any' && dst === 'any') continue;
      const ruleset = str(r.details?.ruleset) ?? str(r.tags?.ruleset) ?? str(r.details?.from) ?? '';
      const fromInternet = /internet in/i.test(ruleset) || /^external|^wan/i.test(str(r.details?.from) ?? '');
      const srcIds = src === 'any' ? (fromInternet ? ['internet'] : []) : resolveEndpoint(src);
      const dstIds = dst === 'any' ? (/internet out/i.test(ruleset) ? ['internet'] : []) : resolveEndpoint(dst);
      if (!srcIds.length || !dstIds.length) continue;
      const type: TopoEdgeType = status === 'allow' ? 'fw_allow' : 'fw_block';
      const port = str(r.details?.destinationPort);
      const note = `${r.name}${ruleset ? ` (${ruleset})` : ''}${port ? ` · port ${port}` : ''}`;
      for (const s of srcIds) for (const d of dstIds) addEdge(s, d, type, port ? `:${port}` : undefined, note);
    }
  }
  if (ipsDenied) {
    nodes.get('internet')!.details.push({ source: 'Firewall', items: [{ label: 'IPS deny-list rules', value: `${ipsDenied} blocked addresses` }] });
  }

  function resolveEndpoint(text: string): string[] {
    const out = new Set<string>();
    // "VLAN104 - Cameras (subnet)" / "Default (subnet)" → that network
    const subnet = /^(.*)\s\(subnet\)$/.exec(text.trim());
    if (subnet) {
      const n = networkByName(subnet[1]);
      if (n) out.add(n.id);
      return [...out];
    }
    // "Name [ip, ip, cidr +5 more]" → members; bare "ip + mac" → each
    const inner = /\[([^\]]*)\]/.exec(text)?.[1] ?? text;
    for (const m of inner.matchAll(IPV4_CIDR)) {
      const c = parseCidr(`${m[1]}/${m[2]}`);
      const n = c && networks.find((x) => x.cidr.base === c.base && x.cidr.bits === c.bits);
      if (n) out.add(n.id);
    }
    const withoutCidrs = inner.replace(IPV4_CIDR, '');
    for (const ip of ipsIn(withoutCidrs)) {
      const h = hostForIp(ip);
      if (h) out.add(h);
    }
    for (const m of inner.matchAll(MAC)) {
      const h = hostByMac.get(m[1].toLowerCase());
      if (h) out.add(h);
    }
    return [...out];
  }

  // Anything a link points at, or that a firewall rule names, is worth showing by default.
  for (const e of edges.values()) {
    if (e.type === 'uplink') continue;
    for (const id of [e.source, e.target]) {
      const n = nodes.get(id);
      if (n && n.type === 'host') n.infra = true;
    }
  }

  return {
    generatedAt: now.toISOString(),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    feeds: input.feeds,
  };
}

function containerStatus(c: ConnectorResource): TopoStatus {
  const health = String(c.details?.health ?? '').toLowerCase();
  if (health === 'unhealthy') return 'warn';
  // Exited / paused / created read as "off": Docker can't tell a crash from a one-shot job.
  return statusOf(c.status);
}

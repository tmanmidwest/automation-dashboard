import { isPrivateMac, ouiVendor } from '../../common/oui';
import { fingerprintType, parseFingerprintDb, resolveDeviceType, type FingerprintDb } from '../../common/device-type';
import type {
  Connector,
  ConnectorContext,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorManifest,
  ConnectorNode,
  ConnectorOverview,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  OperationProgress,
  OperationResult,
  OverviewMetric,
  TestConnectionResult,
} from '@cerebro/shared';
import {
  UniFiApi,
  UniApiError,
  UniAuth,
  UniClient,
  UniDevice,
  UniEvent,
  UniFirewallGroup,
  UniFirewallPolicy,
  UniFirewallRule,
  UniFirewallZone,
  UniHealthSubsystem,
  UniPolicyEndpoint,
  UniTrafficRule,
  UniPort,
  UniSysinfo,
  UniWan,
} from './unifi-api';

const DEVICE_KIND = 'device';
const CLIENT_KIND = 'client';
const BLOCKED_KIND = 'blocked_client';
const WAN_KIND = 'wan';
const NETWORK_KIND = 'network';
const WLAN_KIND = 'wlan';
const PORT_FORWARD_KIND = 'port_forward';
const ALARM_KIND = 'alarm';
const EVENT_KIND = 'event';
const FIREWALL_KIND = 'firewall_rule';
const FW_GROUP_KIND = 'firewall_group';
const FW_ZONE_KIND = 'firewall_zone';

/** Firewall config changes rarely; reuse it for a minute across list/describe/overview. */
const FIREWALL_TTL_MS = 60_000;
const FINGERPRINT_TTL_MS = 24 * 3600_000;
const PORT_SUB = 'port';

/** How long a fetched snapshot (sysinfo/health/devices/clients) is reused across calls. */
const SNAPSHOT_TTL_MS = 10_000;

/** Classic Network-app device state codes → a status string the UI colors. */
const DEVICE_STATE: Record<number, string> = {
  0: 'offline',
  1: 'online',
  2: 'pending',
  3: 'firmware_mismatch',
  4: 'upgrading',
  5: 'provisioning',
  6: 'heartbeat_missed',
  7: 'adopting',
  8: 'deleting',
  9: 'adopt_failed',
  10: 'managed_by_other',
  11: 'isolated',
};

const DEVICE_TYPE_LABEL: Record<string, string> = {
  uap: 'Access point',
  usw: 'Switch',
  ugw: 'Gateway',
  udm: 'Gateway',
  uxg: 'Gateway',
  ubb: 'Building bridge',
  uph: 'Phone',
  ulte: 'LTE backup',
  usp: 'SmartPower',
};

const GATEWAY_TYPES = new Set(['udm', 'ugw', 'uxg']);

/** System-log severities that count as an alarm (the log uses low / medium / high / very_high / critical). */
const HIGH_SEVERITY = new Set(['high', 'very_high', 'critical']);

/** How long the 24h system-log pull is reused by the overview and Alarms tab. */
const EVENTS_TTL_MS = 60_000;

const KINDS: ConnectorResourceKind[] = [
  {
    id: DEVICE_KIND,
    label: 'Devices',
    deletable: false,
    actions: [
      { id: 'locate', label: 'Locate (blink LED)', mutating: true, showWhenStatus: ['online'] },
      { id: 'unlocate', label: 'Stop locating', mutating: true, showWhenStatus: ['online'] },
      { id: 'restart', label: 'Restart', mutating: true, showWhenStatus: ['online', 'heartbeat_missed'], confirm: 'Restart this device? Clients on it will drop for a minute or two.', intent: 'destructive' },
      { id: 'upgrade', label: 'Upgrade firmware', mutating: true, showWhenStatus: ['online'], confirm: 'Upgrade this device to the latest firmware? It will reboot.', intent: 'destructive' },
    ],
    subResources: [
      {
        id: PORT_SUB,
        label: 'Ports',
        labelSingular: 'Port',
        itemActions: [
          { id: 'power-cycle', label: 'Power-cycle PoE', operationId: 'port-power-cycle', paramKey: 'port', confirm: 'Cut and restore PoE power on this port? The powered device will reboot.', intent: 'destructive' },
        ],
      },
    ],
  },
  {
    id: CLIENT_KIND,
    label: 'Clients',
    deletable: false,
    actions: [
      { id: 'reconnect', label: 'Reconnect', mutating: true, confirm: 'Force this client to reconnect (wireless clients only)?' },
      { id: 'block', label: 'Block', mutating: true, confirm: 'Block this client from the network? Unblock it from the Blocked clients tab.', intent: 'destructive' },
    ],
  },
  {
    id: BLOCKED_KIND,
    label: 'Blocked clients',
    deletable: false,
    actions: [{ id: 'unblock', label: 'Unblock', mutating: true, confirm: 'Allow this client back on the network?' }],
  },
  { id: WAN_KIND, label: 'Internet (WAN)', deletable: false, actions: [] },
  { id: NETWORK_KIND, label: 'Networks', deletable: false, actions: [] },
  {
    id: WLAN_KIND,
    label: 'Wi-Fi networks',
    deletable: false,
    actions: [
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
      { id: 'disable', label: 'Disable', mutating: true, showWhenStatus: ['enabled'], confirm: 'Disable this Wi-Fi network? Clients on it will be disconnected.', intent: 'destructive' },
    ],
  },
  {
    id: PORT_FORWARD_KIND,
    label: 'Port forwards',
    deletable: false,
    actions: [
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
      { id: 'disable', label: 'Disable', mutating: true, showWhenStatus: ['enabled'], confirm: 'Disable this port forward?' },
    ],
  },
  {
    id: ALARM_KIND,
    label: 'Alarms',
    deletable: false,
    actions: [{ id: 'archive', label: 'Archive', mutating: true }],
  },
  { id: EVENT_KIND, label: 'Events (24h)', deletable: false, actions: [] },
  // Firewall config is read-only on purpose: a bad toggle from here can cut Cerebro (or you) off the console.
  { id: FIREWALL_KIND, label: 'Firewall rules', deletable: false, actions: [] },
  { id: FW_GROUP_KIND, label: 'Firewall groups', deletable: false, actions: [] },
  { id: FW_ZONE_KIND, label: 'Firewall zones', deletable: false, actions: [] },
];

// ── Formatting helpers ────────────────────────────────────────────────────

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function fmtBytes(b?: number): string | null {
  if (b == null || !Number.isFinite(b)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Bytes/sec → "12.3 Mbps". */
function fmtRate(bytesPerSec?: number): string | null {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec)) return null;
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} Kbps`;
  return `${Math.round(bits)} bps`;
}

function mbps(bytesPerSec?: number): number {
  return bytesPerSec ? round((bytesPerSec * 8) / 1e6, 1) : 0;
}

/** Link speed in Mbps → "1 Gbps" / "100 Mbps". */
function fmtLink(speed?: number): string | null {
  if (!speed) return null;
  return speed >= 1000 ? `${speed / 1000} Gbps` : `${speed} Mbps`;
}

function fmtDuration(sec?: number): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtEpoch(sec?: number): string | null {
  if (!sec) return null;
  // The classic API mixes seconds and milliseconds depending on the endpoint.
  const ms = sec > 1e12 ? sec : sec * 1000;
  return new Date(ms).toLocaleString();
}

function rel(sec?: number): string | null {
  if (!sec) return null;
  const ms = sec > 1e12 ? sec : sec * 1000;
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function deviceStatus(d: UniDevice): string {
  if (typeof d.state === 'number') return DEVICE_STATE[d.state] ?? `state ${d.state}`;
  if (typeof d.state === 'string' && d.state) return d.state.toLowerCase();
  return 'unknown';
}

function deviceName(d: UniDevice): string {
  return d.name || d.model_name || d.model || d.mac;
}

function isGateway(d: UniDevice): boolean {
  return GATEWAY_TYPES.has(d.type ?? '') || !!d.wan1;
}

function cpuPct(d: UniDevice): number | undefined {
  return num(d['system-stats']?.cpu);
}

function memPct(d: UniDevice): number | undefined {
  const m = num(d['system-stats']?.mem);
  if (m != null) return m;
  const total = d.sys_stats?.mem_total;
  const used = d.sys_stats?.mem_used;
  return total && used != null ? round((used / total) * 100, 1) : undefined;
}

/** The hottest temperature reading a device reports, in °C. */
function maxTemp(d: UniDevice): number | undefined {
  const temps = (d.temperatures ?? []).map((t) => num(t.value)).filter((v): v is number => v != null);
  if (num(d.general_temperature) != null) temps.push(num(d.general_temperature)!);
  return temps.length ? Math.max(...temps) : undefined;
}

function clientName(c: UniClient): string {
  return c.name || c.display_name || c.hostname || c.oui || c.mac;
}

/** UniFi's vendor, else the IEEE registry; phones and tablets often use a private MAC. */
function clientVendor(c: UniClient): string | null {
  return c.oui || ouiVendor(c.mac) || (isPrivateMac(c.mac) ? 'Private (randomized) MAC' : null);
}

/** Wi-Fi standard from radio_proto (ng/na are 802.11n on 2.4/5 GHz, not "802.11na"). */
const WIFI_STD: Record<string, string> = { be: 'Wi-Fi 7', ax: 'Wi-Fi 6', ac: 'Wi-Fi 5', na: 'Wi-Fi 4', ng: 'Wi-Fi 4', n: 'Wi-Fi 4', g: '802.11g', a: '802.11a', b: '802.11b' };
const RADIO_BAND: Record<string, string> = { ng: '2.4 GHz', na: '5 GHz', '6e': '6 GHz' };

function wifiStandard(c: UniClient): string | null {
  return c.radio_proto ? WIFI_STD[c.radio_proto] ?? `802.11${c.radio_proto}` : null;
}

function wifiBand(c: UniClient): string | null {
  return c.radio ? RADIO_BAND[c.radio] ?? null : null;
}

/** Friendly names for model codes the API returns without a model_name. */
const MODEL_NAMES: Record<string, string> = {
  UDMPROSE: 'Dream Machine SE',
  UDMPRO: 'Dream Machine Pro',
  UDMPROMAX: 'Dream Machine Pro Max',
  UDM: 'Dream Machine',
  UDR: 'Dream Router',
  UCGULTRA: 'Cloud Gateway Ultra',
  UCGMAX: 'Cloud Gateway Max',
  U7PRO: 'U7 Pro',
  U7PROMAX: 'U7 Pro Max',
  U7PG2: 'UAP AC Pro',
  U6LR: 'U6 Long-Range',
  U6PRO: 'U6 Pro',
  U6LITE: 'U6 Lite',
  U6M: 'U6 Mesh',
  USL24PB: 'USW 24 PoE',
  USL16LP: 'USW Lite 16 PoE',
  USL8LP: 'USW Lite 8 PoE',
  US24PRO: 'USW Pro 24 PoE',
  USF5P: 'USW Flex',
};

function modelName(d: UniDevice): string | null {
  return d.model_name || (d.model ? MODEL_NAMES[d.model.toUpperCase()] ?? d.model : null);
}

function poeWatts(p: UniPort): number {
  return num(p.poe_power) ?? 0;
}

/** WAN slots a gateway can report (UDM SE: WAN1 RJ45, WAN2 SFP+; wan3/4 on some models). */
const WAN_SLOTS = ['wan1', 'wan2', 'wan3', 'wan4'] as const;

interface WanLink {
  id: string;
  label: string;
  wan: UniWan;
  isp?: string;
  latency?: number;
  availability?: number;
}

/** The gateway's WAN links, with ISP + latency joined in from the uptime/geo stats. */
function wanLinks(gw: UniDevice | undefined): WanLink[] {
  if (!gw) return [];
  const out: WanLink[] = [];
  for (const slot of WAN_SLOTS) {
    const wan = (gw as unknown as Record<string, UniWan | undefined>)[slot];
    if (!wan || wan.enable === false) continue;
    const key = slot.toUpperCase().replace('WAN1', 'WAN'); // uptime_stats/geo use "WAN", "WAN2", …
    const up = gw.uptime_stats?.[key] ?? gw.uptime_stats?.[slot.toUpperCase()];
    const geo = gw.active_geo_info?.[key] ?? gw.active_geo_info?.[slot.toUpperCase()];
    out.push({
      id: slot,
      label: `${slot.toUpperCase()}${wan.name && wan.name.toLowerCase() !== slot ? ` · ${wan.name}` : ''}`,
      wan,
      isp: geo?.isp_name || geo?.isp_organization,
      latency: num(up?.latency_average) ?? num(wan.latency),
      availability: num(up?.availability),
    });
  }
  return out;
}

// ── Firewall formatting ───────────────────────────────────────────────────

interface FirewallData {
  at: number;
  rules: UniFirewallRule[] | null;
  groups: UniFirewallGroup[] | null;
  traffic: UniTrafficRule[] | null;
  policies: UniFirewallPolicy[] | null;
  zones: UniFirewallZone[] | null;
  netName: Map<string, string>;
  clientName: Map<string, string>;
}

const RULESET_LABEL: Record<string, string> = {
  WAN_IN: 'Internet In', WAN_OUT: 'Internet Out', WAN_LOCAL: 'Internet Local',
  LAN_IN: 'LAN In', LAN_OUT: 'LAN Out', LAN_LOCAL: 'LAN Local',
  GUEST_IN: 'Guest In', GUEST_OUT: 'Guest Out', GUEST_LOCAL: 'Guest Local',
};
const RULESET_ORDER = ['WAN_IN', 'WAN_OUT', 'WAN_LOCAL', 'LAN_IN', 'LAN_OUT', 'LAN_LOCAL', 'GUEST_IN', 'GUEST_OUT', 'GUEST_LOCAL'];

function rulesetLabel(rs?: string): string | null {
  if (!rs) return null;
  const v6 = /V6/i.test(rs);
  const base = rs.replace(/V6/i, '');
  return `${RULESET_LABEL[base] ?? rs}${v6 ? ' (IPv6)' : ''}`;
}

function rulesetRank(rs?: string): number {
  const v6 = /V6/i.test(rs ?? '') ? 100 : 0;
  const i = RULESET_ORDER.indexOf((rs ?? '').replace(/V6/i, ''));
  return v6 + (i < 0 ? 50 : i);
}

/** accept/ALLOW → allow, drop/BLOCK → block, reject → reject; disabled rules show as disabled. */
function fwStatus(enabled: boolean | undefined, action: string | undefined): string {
  if (enabled === false) return 'disabled';
  const a = (action ?? '').toLowerCase();
  if (a === 'accept' || a === 'allow') return 'allow';
  if (a === 'drop' || a === 'block') return 'block';
  return a || 'enabled';
}

function joinList(xs: (string | null | undefined)[], max = 12): string | null {
  const v = xs.filter((x): x is string => !!x);
  if (!v.length) return null;
  return v.length > max ? `${v.slice(0, max).join(', ')} +${v.length - max} more` : v.join(', ');
}

function groupLabel(g: UniFirewallGroup | undefined, id: string): string {
  if (!g) return id;
  const members = g.group_members ?? [];
  return `${g.name ?? id} [${joinList(members, 6) ?? 'empty'}]`;
}

/** One side of a classic rule: network / address group / IP / MAC → a readable string. */
function classicSide(r: UniFirewallRule, side: 'src' | 'dst', fw: FirewallData, groups: Map<string, UniFirewallGroup>): { where: string; ports: string | null } {
  const parts: string[] = [];
  const ports: string[] = [];
  const netId = r[`${side}_networkconf_id`];
  if (netId) {
    const t = r[`${side}_networkconf_type`];
    parts.push(`${fw.netName.get(netId) ?? netId}${t === 'ADDRv4' ? ' (gateway IP)' : ' (subnet)'}`);
  }
  for (const id of r[`${side}_firewallgroup_ids`] ?? []) {
    const g = groups.get(id);
    if (g?.group_type === 'port-group') ports.push(groupLabel(g, id));
    else parts.push(groupLabel(g, id));
  }
  const addr = r[`${side}_address`];
  if (addr) parts.push(addr);
  if (side === 'src' && r.src_mac_address) parts.push(r.src_mac_address);
  const port = r[`${side}_port`];
  if (port) ports.push(port);
  return { where: parts.join(' + ') || 'any', ports: ports.join(', ') || null };
}

function classicStates(r: UniFirewallRule): string | null {
  const s = [
    r.state_new ? 'new' : null,
    r.state_established ? 'established' : null,
    r.state_related ? 'related' : null,
    r.state_invalid ? 'invalid' : null,
  ];
  return joinList(s) ?? 'all';
}

/** One side of a zone-based policy → "Zone: target". */
function policySide(e: UniPolicyEndpoint | undefined, fw: FirewallData, zoneName: Map<string, string>, groups: Map<string, UniFirewallGroup>): { where: string; ports: string | null; zone: string | null } {
  if (!e) return { where: 'any', ports: null, zone: null };
  const zone = e.zone_id ? zoneName.get(e.zone_id) ?? e.zone_id : null;
  const t = (e.matching_target ?? 'ANY').toUpperCase();
  let target: string | null = null;
  if (t === 'NETWORK') target = joinList((e.network_ids ?? []).map((id) => fw.netName.get(id) ?? id));
  else if (t === 'IP') target = e.ip_group_id ? groupLabel(groups.get(e.ip_group_id), e.ip_group_id) : joinList(e.ips ?? []);
  else if (t === 'CLIENT') target = joinList((e.client_macs ?? []).map((m) => fw.clientName.get(m.toLowerCase()) ?? m));
  else if (t === 'REGION') target = joinList(e.regions ?? []);
  else if (t === 'DOMAIN' || t === 'WEB') target = joinList(e.web_domains ?? []);
  else if (t !== 'ANY') target = t.toLowerCase();
  if (target && e.match_opposite_ips) target = `not ${target}`;
  let ports: string | null = null;
  if (e.port_group_id) ports = groupLabel(groups.get(e.port_group_id), e.port_group_id);
  else if (e.port != null && e.port !== '' && (e.port_matching_type ?? 'SPECIFIC').toUpperCase() !== 'ANY') ports = String(e.port);
  if (ports && e.match_opposite_ports) ports = `not ${ports}`;
  const where = [zone, target].filter(Boolean).join(': ') || 'any';
  return { where, ports, zone };
}

function trafficTargets(t: UniTrafficRule, fw: FirewallData): string | null {
  const xs = (t.target_devices ?? []).map((d) => {
    const type = (d.type ?? '').toUpperCase();
    if (type === 'ALL_CLIENTS') return 'All devices';
    if (type === 'CLIENT' && d.client_mac) return fw.clientName.get(d.client_mac.toLowerCase()) ?? d.client_mac;
    if (type === 'NETWORK' && d.network_id) return fw.netName.get(d.network_id) ?? d.network_id;
    return type.toLowerCase() || null;
  });
  return joinList(xs);
}

function trafficMatch(t: UniTrafficRule): string | null {
  const target = (t.matching_target ?? '').toUpperCase();
  const what =
    target === 'DOMAIN' ? joinList((t.domains ?? []).map((d) => d.domain)) :
    target === 'IP' ? joinList([...(t.ip_addresses ?? []).map((a) => a.ip_or_subnet), ...(t.ip_ranges ?? []).map((r) => `${r.ip_start}–${r.ip_stop}`)]) :
    target === 'REGION' ? joinList(t.regions ?? []) :
    target === 'APP' ? `${(t.app_ids ?? []).length} app(s)` :
    target === 'APP_CATEGORY' ? `${(t.app_category_ids ?? []).length} app categor${(t.app_category_ids ?? []).length === 1 ? 'y' : 'ies'}` :
    target === 'INTERNET' ? 'all internet traffic' : null;
  const label = target ? target.toLowerCase().replace(/_/g, ' ') : null;
  return [label, what && what !== label ? what : null].filter(Boolean).join(': ') || null;
}

function scheduleLabel(s?: { mode?: string; time_range_start?: string; time_range_end?: string; repeat_on_days?: string[] }): string | null {
  if (!s?.mode || s.mode.toUpperCase() === 'ALWAYS') return null;
  const range = s.time_range_start && s.time_range_end ? ` ${s.time_range_start}–${s.time_range_end}` : '';
  const days = s.repeat_on_days?.length ? ` (${s.repeat_on_days.join(', ')})` : '';
  return `${s.mode.toLowerCase()}${range}${days}`;
}

interface Snapshot {
  at: number;
  sysinfo?: UniSysinfo;
  health: UniHealthSubsystem[];
  devices: UniDevice[];
  clients: UniClient[];
  limited: boolean;
  fingerprints: FingerprintDb | null;
}

/**
 * UniFi Network connector for a UniFi OS console (built for the UDM SE; works with any
 * UDM / UCG / UDR / UXG running the Network application).
 *
 * Reads the Network app's controller API through the console: health and WAN/ISP,
 * every adopted device (CPU/mem/temps, ports + PoE, radios, firmware), connected and
 * blocked clients, networks, Wi-Fi, port forwards, alarms and events. Device, port,
 * client, Wi-Fi and alarm actions go through the same API.
 */
export class UniFiConnector implements Connector {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly eventCache = new Map<string, { at: number; events: UniEvent[] }>();
  private readonly firewallCache = new Map<string, FirewallData>();
  private readonly fingerprintCache = new Map<string, { at: number; db: FingerprintDb | null }>();
  /** One API client per instance, so the cached auth mode / Integration-API fallback sticks. */
  private readonly clients = new Map<string, { sig: string; api: UniFiApi }>();

  manifest: ConnectorManifest = {
    id: 'unifi',
    name: 'UniFi Network',
    description:
      'Monitor and manage a UniFi OS console (UDM SE / UDM Pro / Cloud Gateway) — WAN and ISP health, gateway CPU/memory/temperature, every AP and switch with ports and PoE, clients, Wi-Fi, networks, port forwards, alarms and events.',
    version: '0.1.0',
    icon: 'unifi',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Console URL',
        type: 'url',
        required: true,
        placeholder: 'https://192.168.1.1',
        help: 'The UniFi OS console address (the UDM SE\'s LAN IP), https:// — the same address you use for its web UI.',
      },
      {
        key: 'apiKey',
        label: 'API key',
        type: 'password',
        secret: true,
        required: false,
        help: 'Recommended. UniFi Network → Settings → Control Plane → Integrations → Create API key. Leave blank to sign in with a username and password instead.',
      },
      {
        key: 'username',
        label: 'Local admin username (if no API key)',
        type: 'text',
        required: false,
        help: 'A local-only admin on the console (UniFi OS → Admins & Users). Cloud (ui.com) accounts with MFA can\'t sign in here.',
      },
      {
        key: 'password',
        label: 'Local admin password (if no API key)',
        type: 'password',
        secret: true,
        required: false,
      },
      {
        key: 'site',
        label: 'Site',
        type: 'text',
        required: false,
        default: 'default',
        placeholder: 'default',
        help: 'The Network application site\'s short name. Single-site consoles use "default".',
      },
      {
        key: 'verifyTls',
        label: 'Verify TLS certificate',
        type: 'boolean',
        default: false,
        help: 'UniFi consoles ship a self-signed certificate, so this is off by default. Turn on only if you installed a trusted cert.',
      },
    ],
    resourceKinds: KINDS,
    operations: [
      { id: 'port-power-cycle', label: 'Power-cycle PoE port', scope: 'resource', kind: DEVICE_KIND, fields: [] },
      {
        id: 'speedtest',
        label: 'Run speed test',
        description: 'Run an internet speed test from the gateway. Takes about a minute; results update the WAN tiles.',
        scope: 'create',
        kind: WAN_KIND,
        icon: 'gauge',
        submitLabel: 'Run speed test',
        background: true,
        fields: [],
      },
      {
        id: 'archive-all-alarms',
        label: 'Archive all alarms',
        description: 'Mark every active alarm on this site as archived.',
        scope: 'create',
        kind: ALARM_KIND,
        icon: 'archive',
        submitLabel: 'Archive all',
        fields: [],
      },
    ],
    help: {
      overview:
        'Reads the UniFi Network application on a UniFi OS console over its local API: internet/WAN status, ISP, throughput, latency and speed tests; gateway CPU, memory, temperature and storage; every access point and switch with state, uptime, firmware, ports, PoE draw and radios; connected and blocked clients; networks, Wi-Fi, port forwards, alarms and events. Device restarts, locate, firmware upgrades, PoE power-cycles, client reconnect/block, and Wi-Fi/port-forward toggles are available as actions.',
      setupSteps: [
        'Open the UniFi Network application on the console (e.g. https://192.168.1.1/network).',
        'Go to Settings → Control Plane → Integrations and create an API key. Copy it (shown once).',
        'Enter the console URL and paste the API key here. Leave TLS verification off unless the console has a trusted certificate.',
        'Make sure the Cerebro host can reach the console on TCP 443 — if Cerebro sits on another VLAN, allow it in the UniFi firewall.',
        'Alternative: leave the API key blank and enter a local-only admin username and password.',
      ],
      requiredPermissions: [
        'An API key (or local account) with admin access to the Network application. Read-only accounts can monitor but not run actions.',
      ],
      referenceLinks: [
        { label: 'UniFi Network API (Integrations)', url: 'https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API' },
        { label: 'Community API reference (classic endpoints)', url: 'https://ubntwiki.com/products/software/unifi-controller/api' },
      ],
      notes:
        'Some firmware only accepts API keys on the official Integration API. When that happens, Cerebro still lists devices and clients, but WAN health, ports/PoE, alarms, config and actions need a local admin username/password instead — the connection test tells you which mode is active.',
    },
  };

  // ── Plumbing ────────────────────────────────────────────────────────────

  private authFrom(ctx: ConnectorContext): UniAuth {
    const c = ctx.config;
    const s = (v: unknown) => (v == null ? '' : String(v).trim());
    return {
      baseUrl: s(c.baseUrl),
      apiKey: s(c.apiKey) || undefined,
      username: s(c.username) || undefined,
      password: c.password == null ? undefined : String(c.password) || undefined,
      site: s(c.site) || 'default',
      verifyTls: c.verifyTls === true || c.verifyTls === 'true',
    };
  }

  private cacheKey(ctx: ConnectorContext): string {
    return ctx.instanceId ?? String(ctx.config.baseUrl ?? '');
  }

  private apiFor(ctx: ConnectorContext): UniFiApi {
    const auth = this.authFrom(ctx);
    const sig = JSON.stringify([auth.baseUrl, auth.apiKey, auth.username, auth.password, auth.site, auth.verifyTls]);
    const key = this.cacheKey(ctx);
    const cur = this.clients.get(key);
    if (cur && cur.sig === sig) return cur.api;
    const api = new UniFiApi(auth);
    this.clients.set(key, { sig, api });
    this.snapshots.delete(key);
    return api;
  }

  private async snapshot(ctx: ConnectorContext, fresh = false): Promise<Snapshot> {
    const key = this.cacheKey(ctx);
    const api = this.apiFor(ctx);
    const cached = this.snapshots.get(key);
    if (!fresh && cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached;
    // Devices first: it decides whether we're on the classic API or the Integration fallback.
    const devices = await api.devices();
    const [clients, health, sysinfo] = await Promise.all([
      api.clients(),
      api.health().catch((err) => {
        ctx.log('debug', `UniFi health unavailable: ${err instanceof Error ? err.message : err}`);
        return [] as UniHealthSubsystem[];
      }),
      api.limited ? Promise.resolve(undefined) : api.sysinfo().catch(() => undefined),
    ]);
    const snap: Snapshot = { at: Date.now(), devices, clients, health, sysinfo, limited: api.limited, fingerprints: await this.fingerprints(ctx, api) };
    this.snapshots.set(key, snap);
    return snap;
  }

  /** The console's fingerprint table, fetched at most once a day (it's large and rarely changes). */
  private async fingerprints(ctx: ConnectorContext, api: UniFiApi): Promise<FingerprintDb | null> {
    const key = this.cacheKey(ctx);
    const c = this.fingerprintCache.get(key);
    if (c && Date.now() - c.at < FINGERPRINT_TTL_MS) return c.db;
    const db = parseFingerprintDb(await api.fingerprintTable());
    if (!db) ctx.log('debug', 'UniFi fingerprint table unavailable; device types are guessed from name and maker.');
    this.fingerprintCache.set(key, { at: Date.now(), db });
    return db;
  }

  invalidateCache(ctx: ConnectorContext): void {
    this.snapshots.delete(this.cacheKey(ctx));
    this.eventCache.delete(this.cacheKey(ctx));
    this.firewallCache.delete(this.cacheKey(ctx));
  }

  /** The last 24h of events (up to 2000), cached briefly so the per-refresh overview stays cheap. */
  private async eventsCached(ctx: ConnectorContext, fresh = false): Promise<UniEvent[]> {
    const key = this.cacheKey(ctx);
    const c = this.eventCache.get(key);
    if (!fresh && c && Date.now() - c.at < EVENTS_TTL_MS) return c.events;
    const events = await this.apiFor(ctx).events(24, 2000);
    this.eventCache.set(key, { at: Date.now(), events });
    return events;
  }

  /**
   * Every firewall source the console has, fetched together: classic rules + groups,
   * traffic rules, and (Network 9+) zone-based policies + zones. Each is `null` when the
   * firmware doesn't serve it, so whichever model is in use simply shows up.
   */
  private async firewallData(ctx: ConnectorContext, fresh = false): Promise<FirewallData> {
    const key = this.cacheKey(ctx);
    const c = this.firewallCache.get(key);
    if (!fresh && c && Date.now() - c.at < FIREWALL_TTL_MS) return c;
    const api = this.apiFor(ctx);
    const soft = <T>(what: string, p: Promise<T | null>): Promise<T | null> =>
      p.catch((err) => {
        ctx.log('debug', `UniFi ${what} unavailable: ${err instanceof Error ? err.message : err}`);
        return null;
      });
    const [rules, groups, traffic, policies, zones, nets, known] = await Promise.all([
      soft('firewall rules', api.firewallRules()),
      soft('firewall groups', api.firewallGroups()),
      soft('traffic rules', api.trafficRules()),
      soft('firewall policies', api.firewallPolicies()),
      soft('firewall zones', api.firewallZones()),
      api.networks().catch(() => []),
      api.knownClients().catch(() => []),
    ]);
    const data: FirewallData = {
      at: Date.now(),
      rules,
      groups,
      traffic,
      policies,
      zones,
      netName: new Map(nets.map((n) => [n._id, n.name ?? n._id])),
      clientName: new Map(known.map((k) => [k.mac.toLowerCase(), k.name || k.hostname || k.mac])),
    };
    this.firewallCache.set(key, data);
    return data;
  }

  private firewallResources(fw: FirewallData): ConnectorResource[] {
    const groups = new Map((fw.groups ?? []).map((g) => [g._id, g]));
    const zoneName = new Map((fw.zones ?? []).map((z) => [z._id, z.name ?? z.zone_key ?? z._id]));
    const out: ConnectorResource[] = [];

    // Zone-based policies: custom first, then built-in, each in evaluation order.
    const policies = (fw.policies ?? []).slice().sort((a, b) => Number(!!a.predefined) - Number(!!b.predefined) || (a.index ?? 0) - (b.index ?? 0));
    for (const p of policies) {
      const src = policySide(p.source, fw, zoneName, groups);
      const dst = policySide(p.destination, fw, zoneName, groups);
      const states = p.connection_state_type && p.connection_state_type.toUpperCase() !== 'ALL' ? joinList((p.connection_states ?? []).map((x) => x.toLowerCase())) ?? p.connection_state_type.toLowerCase() : 'all';
      out.push({
        id: `policy:${p._id}`,
        kind: FIREWALL_KIND,
        name: p.name || p._id,
        status: fwStatus(p.enabled, p.action),
        details: {
          type: p.predefined ? 'Zone policy (built-in)' : 'Zone policy',
          order: p.index ?? null,
          action: p.action?.toLowerCase() ?? null,
          source: src.where,
          sourcePort: src.ports,
          destination: dst.where,
          destinationPort: dst.ports,
          protocol: p.protocol && p.protocol.toLowerCase() !== 'all' ? p.protocol : 'any',
          ipVersion: p.ip_version ? p.ip_version.toLowerCase().replace('_', ' + ') : null,
          states,
          logging: p.logging ? true : null,
          schedule: scheduleLabel(p.schedule),
          description: p.description || null,
        },
        tags: {
          type: 'zone policy',
          origin: p.predefined ? 'built-in' : 'custom',
          ...(src.zone ? { from: src.zone } : {}),
          ...(dst.zone ? { to: dst.zone } : {}),
        },
      });
    }

    // Classic rules, grouped by ruleset (Internet In/Out/Local, LAN…, Guest…) in rule order.
    const rules = (fw.rules ?? []).slice().sort((a, b) => rulesetRank(a.ruleset) - rulesetRank(b.ruleset) || (a.rule_index ?? 0) - (b.rule_index ?? 0));
    for (const r of rules) {
      const src = classicSide(r, 'src', fw, groups);
      const dst = classicSide(r, 'dst', fw, groups);
      const proto = r.protocol && r.protocol !== 'all' ? `${r.protocol_match_excepted ? 'not ' : ''}${r.protocol}` : 'any';
      out.push({
        id: `rule:${r._id}`,
        kind: FIREWALL_KIND,
        name: r.name || r._id,
        status: fwStatus(r.enabled, r.action),
        details: {
          type: 'Firewall rule',
          ruleset: rulesetLabel(r.ruleset),
          order: r.rule_index ?? null,
          action: r.action ?? null,
          source: src.where,
          sourcePort: src.ports,
          destination: dst.where,
          destinationPort: dst.ports,
          protocol: proto,
          states: classicStates(r),
          ipsec: r.ipsec ? r.ipsec.replace(/-/g, ' ') : null,
          logging: r.logging ? true : null,
        },
        tags: { type: 'firewall rule', origin: 'custom', ...(r.ruleset ? { ruleset: rulesetLabel(r.ruleset) ?? r.ruleset } : {}) },
      });
    }

    // Traffic rules (block/allow by app, domain, region, IP; optional bandwidth limits).
    for (const t of fw.traffic ?? []) {
      const bw = t.bandwidth_limit?.enabled
        ? `↓ ${t.bandwidth_limit.download_limit_kbps ?? '∞'} / ↑ ${t.bandwidth_limit.upload_limit_kbps ?? '∞'} kbps`
        : null;
      out.push({
        id: `traffic:${t._id}`,
        kind: FIREWALL_KIND,
        name: t.description || trafficMatch(t) || t._id,
        status: fwStatus(t.enabled, t.action),
        details: {
          type: 'Traffic rule',
          action: t.action?.toLowerCase() ?? null,
          appliesTo: trafficTargets(t, fw),
          match: trafficMatch(t),
          bandwidthLimit: bw,
          schedule: scheduleLabel(t.schedule),
        },
        tags: { type: 'traffic rule', origin: 'custom' },
      });
    }
    return out;
  }

  private gatewayOf(snap: Snapshot): UniDevice | undefined {
    return snap.devices.find(isGateway);
  }

  private sub(snap: Snapshot, name: string): UniHealthSubsystem | undefined {
    return snap.health.find((h) => h.subsystem === name);
  }

  // ── Connector API ────────────────────────────────────────────────────────

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const auth = this.authFrom(ctx);
    if (!auth.baseUrl) return { ok: false, message: 'Set the console URL.' };
    if (!auth.apiKey && !(auth.username && auth.password)) {
      return { ok: false, message: 'Set an API key, or a local admin username and password.' };
    }
    try {
      const snap = await this.snapshot(ctx, true);
      const gw = this.gatewayOf(snap);
      const version = snap.sysinfo?.version;
      const consoleName = snap.sysinfo?.name || snap.sysinfo?.hostname || (gw ? deviceName(gw) : 'UniFi console');
      const details: Record<string, string> = {
        devices: String(snap.devices.length),
        clients: String(snap.clients.length),
        mode: snap.limited ? 'Integration API (limited)' : 'Network controller API',
      };
      if (version) details.version = version;
      if (gw?.model) details.gateway = gw.model;
      const base = `Connected to ${consoleName}${version ? ` (Network ${version})` : ''} — ${snap.devices.length} devices, ${snap.clients.length} clients.`;
      const msg = snap.limited
        ? `${base} This console only accepts the API key on the limited Integration API: WAN health, ports, alarms and actions need a local admin username/password instead.`
        : base;
      ctx.log('info', msg);
      return { ok: true, message: msg, details };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `UniFi connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFor(ctx);
    switch (kind) {
      case DEVICE_KIND: {
        const snap = await this.snapshot(ctx, true);
        const byMac = new Map(snap.devices.map((d) => [d.mac.toLowerCase(), d]));
        return snap.devices
          .slice()
          .sort((a, b) => Number(isGateway(b)) - Number(isGateway(a)) || deviceName(a).localeCompare(deviceName(b), undefined, { numeric: true }))
          .map((d) => this.toDeviceResource(d, byMac));
      }
      case CLIENT_KIND: {
        const snap = await this.snapshot(ctx, true);
        const byMac = new Map(snap.devices.map((d) => [d.mac.toLowerCase(), d]));
        return snap.clients
          .slice()
          .sort((a, b) => clientName(a).localeCompare(clientName(b), undefined, { numeric: true }))
          .map((c) => this.toClientResource(c, byMac, snap.fingerprints));
      }
      case BLOCKED_KIND: {
        const known = await api.knownClients();
        return known
          .filter((k) => k.blocked)
          .map((k) => ({
            id: k.mac,
            kind,
            name: k.name || k.hostname || k.oui || k.mac,
            status: 'blocked',
            details: { mac: k.mac, vendor: k.oui ?? null, lastSeen: rel(k.last_seen), note: k.note ?? null },
          }));
      }
      case WAN_KIND: {
        const snap = await this.snapshot(ctx, true);
        const wanIp = this.sub(snap, 'wan')?.wan_ip;
        return wanLinks(this.gatewayOf(snap)).map((l) => ({
          id: l.id,
          kind,
          name: l.label,
          status: l.wan.up ? 'up' : 'down',
          details: {
            ip: l.wan.ip ?? null,
            isp: l.isp ?? null,
            link: fmtLink(l.wan.speed),
            download: fmtRate(l.wan['rx_bytes-r']),
            upload: fmtRate(l.wan['tx_bytes-r']),
            latency: l.latency != null ? `${l.latency} ms` : null,
            availability: l.availability != null ? `${round(l.availability, 2)}%` : null,
            primary: wanIp && wanIp === l.wan.ip ? true : null,
          },
          tags: l.isp ? { isp: l.isp } : undefined,
        }));
      }
      case NETWORK_KIND: {
        const nets = await api.networks();
        return nets
          .slice()
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }))
          .map((n) => ({
            id: n._id,
            kind,
            name: n.name || n._id,
            status: n.enabled === false ? 'disabled' : 'enabled',
            details: {
              purpose: n.purpose ?? null,
              subnet: n.ip_subnet ?? null,
              vlan: n.vlan_enabled || n.vlan ? String(n.vlan ?? '') || null : null,
              dhcp: n.purpose === 'wan' ? null : n.dhcpd_enabled ? `${n.dhcpd_start ?? ''}–${n.dhcpd_stop ?? ''}` : 'off',
              wan: n.wan_type ?? null,
            },
            tags: n.purpose ? { purpose: n.purpose } : undefined,
          }));
      }
      case WLAN_KIND: {
        const [wlans, nets, snap] = await Promise.all([api.wlans(), api.networks(), this.snapshot(ctx)]);
        const netName = new Map(nets.map((n) => [n._id, n.name ?? n._id]));
        const perSsid = new Map<string, number>();
        for (const c of snap.clients) if (c.essid) perSsid.set(c.essid, (perSsid.get(c.essid) ?? 0) + 1);
        return wlans.map((w) => ({
          id: w._id,
          kind,
          name: w.name || w._id,
          status: w.enabled === false ? 'disabled' : 'enabled',
          details: {
            clients: perSsid.get(w.name ?? '') ?? 0,
            security: [w.security, w.wpa_mode, w.wpa3_support ? 'WPA3' : null].filter(Boolean).join(' / ') || null,
            bands: (w.wlan_bands ?? (w.wlan_band ? [w.wlan_band] : [])).join(', ') || null,
            network: w.networkconf_id ? netName.get(w.networkconf_id) ?? null : null,
            guest: w.is_guest ? true : null,
            hidden: w.hide_ssid ? true : null,
          },
          tags: w.is_guest ? { guest: 'yes' } : undefined,
        }));
      }
      case PORT_FORWARD_KIND: {
        const pfs = await api.portForwards();
        return pfs.map((p) => ({
          id: p._id,
          kind,
          name: p.name || `${p.dst_port} → ${p.fwd}:${p.fwd_port}`,
          status: p.enabled === false ? 'disabled' : 'enabled',
          details: {
            protocol: p.proto ?? null,
            from: p.src && p.src !== 'any' ? p.src : 'any',
            port: p.dst_port ?? null,
            forwardTo: p.fwd ? `${p.fwd}:${p.fwd_port ?? p.dst_port ?? ''}` : null,
            interface: p.pfwd_interface ?? null,
          },
        }));
      }
      case ALARM_KIND: {
        const alarms = await api.alarms();
        if (alarms === null) {
          // No classic alarms on this firmware: show the system log's high-severity entries instead.
          const events = await this.eventsCached(ctx);
          return events
            .filter((e) => HIGH_SEVERITY.has((e.severity ?? '').toLowerCase()))
            .slice(0, 200)
            .map((e) => ({
              id: `log:${e._id}`,
              kind,
              name: e.msg || e.key || e._id,
              status: (e.severity ?? 'high').toLowerCase(),
              details: {
                category: [e.subsystem, e.subcategory].filter(Boolean).join(' / ') || null,
                type: e.key ?? null,
                when: rel(e.time),
                at: fmtEpoch(e.time),
              },
              tags: e.subsystem ? { category: e.subsystem } : undefined,
            }));
        }
        return alarms
          .slice()
          .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
          .map((a) => ({
            id: a._id,
            kind,
            name: a.msg || a.key || a._id,
            status: 'active',
            details: { type: a.key ?? null, subsystem: a.subsystem ?? null, when: fmtEpoch(a.time) ?? a.datetime ?? null },
            tags: a.subsystem ? { subsystem: a.subsystem } : undefined,
          }));
      }
      case EVENT_KIND: {
        const events = (await this.eventsCached(ctx, true).catch((err) => {
          ctx.log('warn', `UniFi events unavailable: ${err instanceof Error ? err.message : err}`);
          return [] as UniEvent[];
        })).slice(0, 200);
        return events
          .slice()
          .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
          .map((e) => ({
            id: e._id,
            kind,
            name: e.msg || e.key || e._id,
            status: e.severity ? e.severity.toLowerCase() : e.subsystem ?? undefined,
            details: {
              category: [e.subsystem, e.subcategory].filter(Boolean).join(' / ') || null,
              type: e.key ?? null,
              when: rel(e.time) ?? e.datetime ?? null,
              at: fmtEpoch(e.time),
            },
            tags: {
              ...(e.subsystem ? { category: e.subsystem } : {}),
              ...(e.severity ? { severity: e.severity.toLowerCase() } : {}),
            },
          }));
      }
      case FIREWALL_KIND:
        return this.firewallResources(await this.firewallData(ctx, true));
      case FW_GROUP_KIND: {
        const fw = await this.firewallData(ctx, true);
        const uses = new Map<string, number>();
        const bump = (id?: string) => id && uses.set(id, (uses.get(id) ?? 0) + 1);
        for (const r of fw.rules ?? []) [...(r.src_firewallgroup_ids ?? []), ...(r.dst_firewallgroup_ids ?? [])].forEach(bump);
        for (const p of fw.policies ?? []) [p.source?.ip_group_id, p.source?.port_group_id, p.destination?.ip_group_id, p.destination?.port_group_id].forEach(bump);
        return (fw.groups ?? [])
          .slice()
          .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }))
          .map((g) => ({
            id: g._id,
            kind,
            name: g.name || g._id,
            details: {
              type: (g.group_type ?? '').replace(/-/g, ' ') || null,
              members: joinList(g.group_members ?? [], 50) ?? 'empty',
              count: (g.group_members ?? []).length,
              usedBy: uses.get(g._id) ?? 0,
            },
            tags: g.group_type ? { type: g.group_type } : undefined,
          }));
      }
      case FW_ZONE_KIND: {
        const fw = await this.firewallData(ctx, true);
        return (fw.zones ?? []).map((z) => {
          const from = (fw.policies ?? []).filter((p) => p.source?.zone_id === z._id && !p.predefined).length;
          const to = (fw.policies ?? []).filter((p) => p.destination?.zone_id === z._id && !p.predefined).length;
          return {
            id: z._id,
            kind,
            name: z.name || z.zone_key || z._id,
            details: {
              key: z.zone_key ?? null,
              networks: joinList((z.network_ids ?? []).map((id) => fw.netName.get(id) ?? id), 30) ?? 'none',
              customPoliciesFrom: from,
              customPoliciesTo: to,
            },
          };
        });
      }
      default:
        return [];
    }
  }

  private toDeviceResource(d: UniDevice, byMac: Map<string, UniDevice>): ConnectorResource {
    const typeLabel = DEVICE_TYPE_LABEL[d.type ?? ''] ?? d.type ?? 'Device';
    const cpu = cpuPct(d);
    const mem = memPct(d);
    const temp = maxTemp(d);
    const uplink = d.uplink?.uplink_mac ? byMac.get(d.uplink.uplink_mac.toLowerCase()) : undefined;
    const poe = (d.port_table ?? []).reduce((s, p) => s + poeWatts(p), 0);
    return {
      id: d.mac,
      kind: DEVICE_KIND,
      name: deviceName(d),
      status: deviceStatus(d),
      details: {
        type: typeLabel,
        model: modelName(d),
        ip: d.ip ?? null,
        uptime: d.uptime ? fmtDuration(d.uptime) : null,
        firmware: d.version ? (d.upgradable ? `${d.version} → ${d.upgrade_to_firmware ?? 'update'}` : d.version) : null,
        clients: d.num_sta ?? null,
        cpu: cpu != null ? `${round(cpu)}%` : null,
        memory: mem != null ? `${round(mem)}%` : null,
        temp: temp != null ? `${round(temp)}°C` : null,
        poe: poe ? `${round(poe, 1)} W` : null,
        uplink: uplink ? `${deviceName(uplink)}${d.uplink?.uplink_remote_port ? ` port ${d.uplink.uplink_remote_port}` : ''}` : isGateway(d) ? null : d.uplink?.type ?? null,
      },
      tags: {
        type: typeLabel,
        ...(d.upgradable ? { firmware: 'update available' } : {}),
      },
    };
  }

  /** Where a client is attached: AP for Wi-Fi; switch + port for wired, falling back to the
   *  "last uplink" newer firmware reports (also set for clients behind unmanaged switches). */
  private clientVia(c: UniClient, byMac: Map<string, UniDevice>): string | null {
    const ap = c.ap_mac ? byMac.get(c.ap_mac.toLowerCase()) : undefined;
    const sw = c.sw_mac ? byMac.get(c.sw_mac.toLowerCase()) : undefined;
    const up = c.uplink_mac ? byMac.get(c.uplink_mac.toLowerCase()) : undefined;
    const last = c.last_uplink_mac ? byMac.get(c.last_uplink_mac.toLowerCase()) : undefined;
    const lastName = last ? deviceName(last) : c.last_uplink_name;
    if (!c.is_wired) return ap ? deviceName(ap) : up ? deviceName(up) : lastName ?? null;
    if (sw) return `${deviceName(sw)}${c.sw_port ? ` port ${c.sw_port}` : ''}`;
    if (lastName) return `${lastName}${c.last_uplink_remote_port ? ` port ${c.last_uplink_remote_port}` : ''}`;
    return up ? deviceName(up) : null;
  }

  private toClientResource(c: UniClient, byMac: Map<string, UniDevice>, fp: FingerprintDb | null): ConnectorResource {
    const via = this.clientVia(c, byMac);
    const kind = resolveDeviceType(fingerprintType(fp, c), { name: clientName(c), hostname: c.hostname, vendor: clientVendor(c) });
    const tags: Record<string, string> = { connection: c.is_wired ? 'wired' : 'wireless' };
    if (c.network) tags.network = c.network;
    if (c.essid) tags.ssid = c.essid;
    if (c.is_guest) tags.guest = 'yes';
    const band = wifiBand(c);
    if (!c.is_wired && band) tags.band = band;
    return {
      id: c.mac,
      kind: CLIENT_KIND,
      name: clientName(c),
      status: c.blocked ? 'blocked' : 'online',
      details: {
        ip: c.ip || c.last_ip || null,
        mac: c.mac,
        connection: c.is_wired ? 'Wired' : [c.essid, wifiStandard(c), band].filter(Boolean).join(' · ') || 'Wireless',
        via,
        signal: !c.is_wired && c.signal != null ? `${c.signal} dBm` : null,
        down: fmtRate(c['tx_bytes-r']), // tx from the network's point of view = client download
        up: fmtRate(c['rx_bytes-r']),
        uptime: fmtDuration(c.uptime),
        vendor: clientVendor(c),
        deviceType: kind?.type ?? null,
        deviceModel: kind?.model ?? null,
        typeFrom: kind?.source ?? null,
        hostname: c.hostname && c.hostname !== clientName(c) ? c.hostname : null,
        network: c.network ?? null,
        vlan: c.vlan ?? null,
        fixedIp: c.use_fixedip ? c.fixed_ip ?? null : null,
        linkRate: c.tx_rate ? `${round(c.tx_rate / 1000)} / ${round((c.rx_rate ?? 0) / 1000)} Mbps` : null,
        experience: c.satisfaction != null && c.satisfaction >= 0 ? `${c.satisfaction}%` : null,
        downloaded: fmtBytes(c.tx_bytes),
        uploaded: fmtBytes(c.rx_bytes),
        firstSeen: fmtEpoch(c.first_seen),
        lastSeen: fmtEpoch(c.last_seen),
        guest: c.is_guest ? 'yes' : null,
        /** Machine-readable first sighting, for new-device detection (not shown on the map). */
        firstSeenAt: c.first_seen ? new Date(c.first_seen * 1000).toISOString() : null,
      },
      tags,
    };
  }

  async listSubResources(ctx: ConnectorContext, kind: string, resourceId: string, subKind: string): Promise<ConnectorResource[]> {
    if (kind !== DEVICE_KIND || subKind !== PORT_SUB) return [];
    const snap = await this.snapshot(ctx, true);
    const d = snap.devices.find((x) => x.mac.toLowerCase() === resourceId.toLowerCase());
    if (!d) throw new Error(`Device ${resourceId} not found.`);
    // Who's plugged in where: clients by switch port, and adopted devices by uplink port.
    const onPort = new Map<number, string[]>();
    const add = (port: number | undefined, name: string) => {
      if (!port) return;
      const l = onPort.get(port) ?? [];
      l.push(name);
      onPort.set(port, l);
    };
    for (const c of snap.clients) if (c.sw_mac?.toLowerCase() === d.mac.toLowerCase()) add(c.sw_port, clientName(c));
    for (const x of snap.devices) if (x.uplink?.uplink_mac?.toLowerCase() === d.mac.toLowerCase()) add(x.uplink.uplink_remote_port, deviceName(x));
    return (d.port_table ?? [])
      .slice()
      .sort((a, b) => (a.port_idx ?? 0) - (b.port_idx ?? 0))
      .map((p) => {
        const idx = p.port_idx ?? 0;
        const neighbour = p.lldp_table?.[0]?.lldp_system_name;
        const connected = onPort.get(idx) ?? (neighbour ? [neighbour] : []);
        const errors = (p.rx_errors ?? 0) + (p.tx_errors ?? 0);
        const speed = p.up ? `${fmtLink(p.speed) ?? '—'}${p.full_duplex === false ? ' half' : ''}` : null;
        const poe = p.port_poe ? (poeWatts(p) ? `${round(poeWatts(p), 1)} W` : p.poe_enable === false || p.poe_mode === 'off' ? 'PoE off' : '0 W') : null;
        // The drawer's sub-resource rows show `summary` as the one-line description.
        const summary = [
          speed,
          poe ? (poe.startsWith('PoE') ? poe : `PoE ${poe}`) : null,
          p.is_uplink ? 'uplink' : null,
          connected.length ? `→ ${connected.slice(0, 3).join(', ')}${connected.length > 3 ? ` +${connected.length - 3}` : ''}` : null,
          errors ? `${errors} errors` : null,
        ].filter(Boolean).join(' · ');
        return {
          id: String(idx),
          kind: PORT_SUB,
          name: `Port ${idx}${p.name && p.name !== `Port ${idx}` ? ` · ${p.name}` : ''}`,
          status: p.enable === false ? 'disabled' : p.up ? 'up' : 'no_link',
          details: {
            summary: summary || null,
            speed,
            poe,
            connected: connected.length ? connected.slice(0, 4).join(', ') + (connected.length > 4 ? ` +${connected.length - 4}` : '') : null,
            down: fmtRate(p['tx_bytes-r']),
            up: fmtRate(p['rx_bytes-r']),
            errors: errors || null,
            uplink: p.is_uplink ? true : null,
            media: p.media ?? null,
          },
        };
      });
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    if (kind === DEVICE_KIND) return this.describeDevice(ctx, resourceId);
    if (kind === CLIENT_KIND) return this.describeClient(ctx, resourceId);
    // Everything else: the list row's details are the whole story.
    const rows = await this.listResources(ctx, kind);
    const r = rows.find((x) => x.id === resourceId);
    if (!r) throw new Error(`${kind} ${resourceId} not found.`);
    const items: ConnectorDetailItem[] = Object.entries(r.details ?? {})
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()), value: v === true ? 'Yes' : String(v) }));
    return { id: r.id, kind, name: r.name, status: r.status, groups: [{ title: 'General', items }] };
  }

  private async describeDevice(ctx: ConnectorContext, mac: string): Promise<ConnectorResourceDetail> {
    const snap = await this.snapshot(ctx, true);
    const d = snap.devices.find((x) => x.mac.toLowerCase() === mac.toLowerCase());
    if (!d) throw new Error(`Device ${mac} not found.`);
    const byMac = new Map(snap.devices.map((x) => [x.mac.toLowerCase(), x]));
    const status = deviceStatus(d);
    const groups: ConnectorDetailGroup[] = [];
    const push = (title: string, items: (ConnectorDetailItem | null)[]) => {
      const list = items.filter((i): i is ConnectorDetailItem => !!i && i.value !== '' && i.value !== 'null' && i.value !== 'undefined');
      if (list.length) groups.push({ title, items: list });
    };
    const item = (label: string, value: unknown, variant?: ConnectorDetailItem['variant']): ConnectorDetailItem | null =>
      value == null || value === '' ? null : { label, value: String(value), ...(variant ? { variant } : {}) };

    push('General', [
      item('Type', DEVICE_TYPE_LABEL[d.type ?? ''] ?? d.type),
      item('Model', [modelName(d), d.model].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ')),
      item('State', status, 'status'),
      item('IP address', d.ip, 'mono'),
      item('MAC address', d.mac, 'mono'),
      item('Serial', d.serial, 'mono'),
      item('Uptime', fmtDuration(d.uptime)),
      item('Last seen', rel(d.last_seen)),
      item('Firmware', d.version, 'mono'),
      d.upgradable ? item('Update available', d.upgrade_to_firmware ?? 'yes', 'warn') : null,
      d.locating || d.led_override === 'on' ? item('Locating', 'LED blinking') : null,
    ]);

    const cpu = cpuPct(d);
    const mem = memPct(d);
    push('Health', [
      item('CPU', cpu != null ? `${round(cpu, 1)}%` : null),
      item('Memory', mem != null ? `${round(mem, 1)}%` : null),
      item('Load (1m)', d.sys_stats?.loadavg_1),
      item('Memory total', fmtBytes(d.sys_stats?.mem_total)),
      ...(d.temperatures ?? []).map((t) => item(`Temp · ${t.name ?? t.type ?? 'sensor'}`, num(t.value) != null ? `${round(num(t.value)!, 1)}°C` : null)),
      !d.temperatures?.length ? item('Temperature', num(d.general_temperature) != null ? `${d.general_temperature}°C` : null) : null,
      d.has_fan ? item('Fan level', d.fan_level != null ? `${d.fan_level}%` : null) : null,
      item('Experience', d.satisfaction != null && d.satisfaction >= 0 ? `${d.satisfaction}%` : null),
    ]);

    push('Traffic', [
      item('Clients', d.num_sta),
      item('Users / guests', d['user-num_sta'] != null ? `${d['user-num_sta']} / ${d['guest-num_sta'] ?? 0}` : null),
      item('Download now', fmtRate(d['rx_bytes-r'])),
      item('Upload now', fmtRate(d['tx_bytes-r'])),
      item('Received total', fmtBytes(d.rx_bytes)),
      item('Sent total', fmtBytes(d.tx_bytes)),
    ]);

    if (d.uplink) {
      const up = d.uplink.uplink_mac ? byMac.get(d.uplink.uplink_mac.toLowerCase()) : undefined;
      push('Uplink', [
        item('Type', d.uplink.type),
        up ? { label: 'Upstream device', value: deviceName(up), to: { kind: DEVICE_KIND, id: up.mac } } : null,
        item('Upstream port', d.uplink.uplink_remote_port),
        item('Link speed', fmtLink(d.uplink.speed)),
      ]);
    }

    if (isGateway(d)) {
      const www = this.sub(snap, 'www');
      const st = d['speedtest-status'];
      for (const l of wanLinks(d)) {
        push(l.label, [
          item('Status', l.wan.up ? 'up' : 'down', 'status'),
          item('IP', l.wan.ip, 'mono'),
          item('Gateway', l.wan.gateway, 'mono'),
          item('ISP', l.isp),
          item('Link speed', fmtLink(l.wan.speed)),
          item('Download now', fmtRate(l.wan['rx_bytes-r'])),
          item('Upload now', fmtRate(l.wan['tx_bytes-r'])),
          item('Latency', l.latency != null ? `${l.latency} ms` : null),
          item('Availability', l.availability != null ? `${round(l.availability, 2)}%` : null),
        ]);
      }
      push('Speed test', [
        item('Download', st?.xput_download != null ? `${round(st.xput_download, 1)} Mbps` : www?.xput_down != null ? `${round(www.xput_down, 1)} Mbps` : null),
        item('Upload', st?.xput_upload != null ? `${round(st.xput_upload, 1)} Mbps` : www?.xput_up != null ? `${round(www.xput_up, 1)} Mbps` : null),
        item('Ping', st?.latency != null ? `${st.latency} ms` : www?.speedtest_ping != null ? `${www.speedtest_ping} ms` : null),
        item('Last run', rel(st?.rundate ?? www?.speedtest_lastrun)),
      ]);
      if (snap.sysinfo) {
        push('Console', [
          item('Name', snap.sysinfo.name || snap.sysinfo.hostname),
          item('Network app', snap.sysinfo.version, 'mono'),
          item('UniFi OS', snap.sysinfo.console_display_version || snap.sysinfo.udm_version, 'mono'),
          item('Timezone', snap.sysinfo.timezone),
          snap.sysinfo.update_available ? item('Network app update', 'available', 'warn') : null,
        ]);
      }
    }

    if (d.radio_table_stats?.length) {
      const band = (r?: string) => (r === 'ng' ? '2.4 GHz' : r === 'na' ? '5 GHz' : r === '6e' ? '6 GHz' : r ?? 'radio');
      push(
        'Radios',
        d.radio_table_stats.map((r) =>
          item(
            band(r.radio),
            [
              r.channel != null ? `ch ${r.channel}` : null,
              r.tx_power != null ? `${r.tx_power} dBm` : null,
              r.num_sta != null ? `${r.num_sta} clients` : null,
              r.cu_total != null ? `${r.cu_total}% util` : null,
              r.satisfaction != null && r.satisfaction >= 0 ? `${r.satisfaction}% exp` : null,
            ].filter(Boolean).join(' · '),
          ),
        ),
      );
    }

    if (d.port_table?.length) {
      const ports = d.port_table;
      const poe = ports.reduce((s, p) => s + poeWatts(p), 0);
      push('Ports', [
        item('Ports up', `${ports.filter((p) => p.up).length} / ${ports.length}`),
        item('PoE draw', poe ? `${round(poe, 1)} W${d.total_max_power ? ` of ${d.total_max_power} W` : ''}` : null),
        item('Ports with errors', ports.filter((p) => (p.rx_errors ?? 0) + (p.tx_errors ?? 0) > 0).length || null),
        { label: 'Per-port detail', value: 'See the Ports tab' },
      ]);
    }

    if (d.storage?.length) {
      push(
        'Storage',
        d.storage.map((s) =>
          item(
            s.name || s.mount_point || 'volume',
            s.size ? `${fmtBytes(s.used)} of ${fmtBytes(s.size)} (${round(((s.used ?? 0) / s.size) * 100)}%)` : null,
          ),
        ),
      );
    }

    return { id: d.mac, kind: DEVICE_KIND, name: deviceName(d), status, groups };
  }

  private async describeClient(ctx: ConnectorContext, mac: string): Promise<ConnectorResourceDetail> {
    const snap = await this.snapshot(ctx, true);
    const c = snap.clients.find((x) => x.mac.toLowerCase() === mac.toLowerCase());
    if (!c) throw new Error(`Client ${mac} is not connected.`);
    const byMac = new Map(snap.devices.map((x) => [x.mac.toLowerCase(), x]));
    const r = this.toClientResource(c, byMac, snap.fingerprints);
    const ap = c.ap_mac ? byMac.get(c.ap_mac.toLowerCase()) : undefined;
    const sw = c.sw_mac ? byMac.get(c.sw_mac.toLowerCase()) : undefined;
    const it = (label: string, value: unknown, variant?: ConnectorDetailItem['variant']): ConnectorDetailItem | null =>
      value == null || value === '' ? null : { label, value: String(value), ...(variant ? { variant } : {}) };
    const clean = (l: (ConnectorDetailItem | null)[]) => l.filter((i): i is ConnectorDetailItem => !!i);
    const groups: ConnectorDetailGroup[] = [
      {
        title: 'General',
        items: clean([
          it('Name', c.name),
          it('Hostname', c.hostname, 'mono'),
          it('IP address', c.ip || c.last_ip, 'mono'),
          it('MAC address', c.mac, 'mono'),
          it('Vendor', clientVendor(c)),
          it('Device type', r.details?.deviceType ? `${r.details.deviceType}${r.details.deviceModel ? ` · ${r.details.deviceModel}` : ''} (${r.details.typeFrom})` : null),
          it('Last seen', fmtEpoch(c.last_seen)),
          it('Network', c.network),
          it('VLAN', c.vlan),
          it('Fixed IP', c.use_fixedip ? c.fixed_ip : null, 'mono'),
          it('Guest', c.is_guest ? 'Yes' : null),
          it('Connected for', fmtDuration(c.uptime)),
          it('First seen', fmtEpoch(c.first_seen)),
        ]),
      },
      {
        title: 'Connection',
        items: clean([
          it('Type', c.is_wired ? 'Wired' : 'Wireless'),
          ap ? { label: 'Access point', value: deviceName(ap), to: { kind: DEVICE_KIND, id: ap.mac } } : null,
          sw ? { label: 'Switch', value: `${deviceName(sw)}${c.sw_port ? ` · port ${c.sw_port}` : ''}`, to: { kind: DEVICE_KIND, id: sw.mac } } : null,
          !sw && c.is_wired ? it('Connected via', this.clientVia(c, byMac)) : null,
          it('SSID', c.essid),
          it('Standard', wifiStandard(c)),
          it('Band', wifiBand(c)),
          it('Channel', c.channel),
          it('Signal', !c.is_wired && c.signal != null ? `${c.signal} dBm` : null),
          it('Link rate (down / up)', c.tx_rate ? `${round(c.tx_rate / 1000)} / ${round((c.rx_rate ?? 0) / 1000)} Mbps` : null),
          it('Experience', c.satisfaction != null && c.satisfaction >= 0 ? `${c.satisfaction}%` : null),
        ]),
      },
      {
        title: 'Traffic',
        items: clean([
          it('Download now', fmtRate(c['tx_bytes-r'])),
          it('Upload now', fmtRate(c['rx_bytes-r'])),
          it('Downloaded', fmtBytes(c.tx_bytes)),
          it('Uploaded', fmtBytes(c.rx_bytes)),
        ]),
      },
    ].filter((g) => g.items.length);
    return { id: c.mac, kind: CLIENT_KIND, name: r.name, status: r.status, groups };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const snap = await this.snapshot(ctx);
    const api = this.apiFor(ctx);
    const gw = this.gatewayOf(snap);
    const metrics: OverviewMetric[] = [];
    const m = (key: string, label: string, value: number | undefined, unit?: string) => {
      if (value != null && Number.isFinite(value)) metrics.push({ key, label, value, ...(unit ? { unit } : {}) });
    };

    // Devices
    const statuses = snap.devices.map(deviceStatus);
    m('unifiDevices', 'UniFi devices', snap.devices.length);
    m('unifiDevicesOffline', 'Devices offline', statuses.filter((s) => s === 'offline' || s === 'heartbeat_missed' || s === 'isolated' || s === 'adopt_failed').length);
    m('unifiFirmwareUpdates', 'Firmware updates', snap.devices.filter((d) => d.upgradable).length);
    m('unifiAps', 'Access points', snap.devices.filter((d) => d.type === 'uap').length);
    m('unifiSwitches', 'Switches', snap.devices.filter((d) => d.type === 'usw').length);

    // Clients
    const wired = snap.clients.filter((c) => c.is_wired).length;
    m('unifiClients', 'Clients', snap.clients.length);
    m('unifiClientsWireless', 'Wireless clients', snap.clients.length - wired);
    m('unifiClientsWired', 'Wired clients', wired);
    if (!snap.limited) m('unifiGuests', 'Guests', snap.clients.filter((c) => c.is_guest).length);

    // Internet / WAN
    const links = wanLinks(gw);
    const www = this.sub(snap, 'www');
    const wanHealth = this.sub(snap, 'wan');
    if (links.length) {
      m('unifiWanDown', 'WAN links down', links.filter((l) => !l.wan.up).length);
    } else if (www?.status) {
      m('unifiWanDown', 'WAN links down', www.status === 'ok' ? 0 : 1);
    }
    const primary = links.find((l) => l.wan.ip && l.wan.ip === wanHealth?.wan_ip) ?? links.find((l) => l.wan.up);
    m('unifiWanLatencyMs', 'Internet latency', num(www?.latency) ?? primary?.latency, 'ms');
    const rx = wanHealth?.['rx_bytes-r'] ?? links.reduce((s, l) => s + (l.wan['rx_bytes-r'] ?? 0), 0);
    const tx = wanHealth?.['tx_bytes-r'] ?? links.reduce((s, l) => s + (l.wan['tx_bytes-r'] ?? 0), 0);
    if (!snap.limited && (gw || wanHealth)) {
      m('unifiWanDownMbps', 'WAN download', mbps(rx), 'Mbps');
      m('unifiWanUpMbps', 'WAN upload', mbps(tx), 'Mbps');
    }
    if (primary?.availability != null) m('unifiWanAvailabilityPct', 'WAN availability', round(primary.availability, 2), '%');
    const st = gw?.['speedtest-status'];
    const sDown = num(st?.xput_download) ?? num(www?.xput_down);
    const sUp = num(st?.xput_upload) ?? num(www?.xput_up);
    if (sDown) m('unifiSpeedtestDownMbps', 'Speed test down', round(sDown, 1), 'Mbps');
    if (sUp) m('unifiSpeedtestUpMbps', 'Speed test up', round(sUp, 1), 'Mbps');
    if (www?.drops != null) m('unifiWanDrops', 'WAN drops', www.drops);

    // Gateway health
    if (gw) {
      const cpu = cpuPct(gw);
      const mem = memPct(gw);
      const temp = maxTemp(gw);
      if (cpu != null) m('unifiGatewayCpuPct', 'Gateway CPU', round(cpu), '%');
      if (mem != null) m('unifiGatewayMemPct', 'Gateway memory', round(mem), '%');
      if (temp != null) m('unifiGatewayTempC', 'Gateway temperature', round(temp), '°C');
      const disk = (gw.storage ?? []).filter((s) => s.size && s.size > 0);
      if (disk.length) {
        const size = disk.reduce((s, x) => s + (x.size ?? 0), 0);
        const used = disk.reduce((s, x) => s + (x.used ?? 0), 0);
        m('unifiStoragePct', 'Console storage used', round((used / size) * 100), '%');
      }
    }

    // PoE
    const poe = snap.devices.reduce((s, d) => s + (d.port_table ?? []).reduce((t, p) => t + poeWatts(p), 0), 0);
    if (poe) m('unifiPoeWatts', 'PoE draw', round(poe, 1), 'W');

    // VPN
    const vpn = this.sub(snap, 'vpn');
    if (vpn?.remote_user_enabled) m('unifiVpnUsers', 'VPN users connected', vpn.remote_user_num_active ?? 0);

    // Alarms + the last 24h of the system log — best-effort (not every firmware/key exposes them).
    if (!snap.limited) {
      try {
        const alarms = await api.alarms();
        if (alarms !== null) m('unifiAlarms', 'Active alarms', alarms.length);
      } catch (err) {
        ctx.log('debug', `UniFi alarms unavailable: ${err instanceof Error ? err.message : err}`);
      }
      try {
        const events = await this.eventsCached(ctx);
        const cat = (e: UniEvent) => `${e.subsystem ?? ''}/${e.subcategory ?? ''}`.toUpperCase();
        m('unifiHighEvents24h', 'High-severity events (24h)', events.filter((e) => HIGH_SEVERITY.has((e.severity ?? '').toLowerCase())).length);
        m('unifiThreats24h', 'Threats blocked (24h)', events.filter((e) => cat(e).includes('INTRUSION') || (e.key ?? '').startsWith('THREAT_')).length);
        m('unifiFirewallBlocks24h', 'Firewall blocks (24h)', events.filter((e) => cat(e).includes('SECURITY_FIREWALL')).length);
      } catch (err) {
        ctx.log('debug', `UniFi events unavailable: ${err instanceof Error ? err.message : err}`);
      }
      const fw = await this.firewallData(ctx).catch(() => undefined);
      if (fw && (fw.rules || fw.policies || fw.traffic)) {
        const custom =
          (fw.rules ?? []).filter((r) => r.enabled !== false).length +
          (fw.policies ?? []).filter((p) => !p.predefined && p.enabled !== false).length +
          (fw.traffic ?? []).filter((t) => t.enabled !== false).length;
        m('unifiFirewallRules', 'Firewall rules (custom, enabled)', custom);
      }
    }

    // Problems first: offline devices, then the rest.
    const bad = (s: string) => (s === 'online' ? 0 : 1);
    const guests = snap.devices
      .slice()
      .sort((a, b) => bad(deviceStatus(b)) - bad(deviceStatus(a)) || Number(isGateway(b)) - Number(isGateway(a)) || deviceName(a).localeCompare(deviceName(b)))
      .slice(0, 40)
      .map((d) => ({ name: deviceName(d), kind: DEVICE_TYPE_LABEL[d.type ?? '']?.toLowerCase() ?? 'device', status: deviceStatus(d), node: d.model ?? '' }));

    return { metrics, guests };
  }

  async listNodes(ctx: ConnectorContext): Promise<ConnectorNode[]> {
    try {
      const snap = await this.snapshot(ctx);
      const gw = this.gatewayOf(snap);
      if (!gw) return [];
      const mem = memPct(gw);
      const total = gw.sys_stats?.mem_total;
      return [
        {
          name: deviceName(gw),
          status: deviceStatus(gw),
          cpuPct: cpuPct(gw) ?? 0,
          memTotalBytes: total,
          memUsedBytes: total && mem != null ? Math.round((total * mem) / 100) : gw.sys_stats?.mem_used,
          uptimeSeconds: gw.uptime,
        },
      ];
    } catch (err) {
      ctx.log('debug', `UniFi listNodes failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  async performAction(ctx: ConnectorContext, kind: string, resourceId: string, actionId: string): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFor(ctx);
    try {
      let message: string;
      if (kind === DEVICE_KIND) {
        const snap = await this.snapshot(ctx);
        const d = snap.devices.find((x) => x.mac.toLowerCase() === resourceId.toLowerCase());
        const name = d ? deviceName(d) : resourceId;
        if (actionId === 'restart') {
          await api.restartDevice(resourceId);
          message = `Restarting ${name}.`;
        } else if (actionId === 'locate' || actionId === 'unlocate') {
          await api.locateDevice(resourceId, actionId === 'locate');
          message = actionId === 'locate' ? `${name} is blinking its LED.` : `Stopped locating ${name}.`;
        } else if (actionId === 'upgrade') {
          if (d && d.upgradable === false) return { ok: false, message: `${name} is already on the latest firmware (${d.version ?? 'unknown'}).` };
          await api.upgradeDevice(resourceId);
          message = `Upgrading ${name}${d?.upgrade_to_firmware ? ` to ${d.upgrade_to_firmware}` : ''}. It will reboot when done.`;
        } else {
          return { ok: false, message: `Unsupported device action "${actionId}".` };
        }
      } else if (kind === CLIENT_KIND && actionId === 'reconnect') {
        await api.kickClient(resourceId);
        message = `Asked ${resourceId} to reconnect.`;
      } else if (kind === CLIENT_KIND && actionId === 'block') {
        await api.blockClient(resourceId, true);
        message = `Blocked ${resourceId}.`;
      } else if (kind === BLOCKED_KIND && actionId === 'unblock') {
        await api.blockClient(resourceId, false);
        message = `Unblocked ${resourceId}.`;
      } else if (kind === WLAN_KIND && (actionId === 'enable' || actionId === 'disable')) {
        await api.setWlanEnabled(resourceId, actionId === 'enable');
        message = `Wi-Fi network ${actionId === 'enable' ? 'enabled' : 'disabled'}.`;
      } else if (kind === PORT_FORWARD_KIND && (actionId === 'enable' || actionId === 'disable')) {
        await api.setPortForwardEnabled(resourceId, actionId === 'enable');
        message = `Port forward ${actionId === 'enable' ? 'enabled' : 'disabled'}.`;
      } else if (kind === ALARM_KIND && actionId === 'archive') {
        if (resourceId.startsWith('log:')) {
          return { ok: false, message: 'This entry comes from the UniFi system log, which this firmware uses instead of alarms; it can\'t be archived.' };
        }
        await api.archiveAlarm(resourceId);
        message = 'Alarm archived.';
      } else {
        return { ok: false, message: `Unsupported action "${actionId}" for ${kind}.` };
      }
      this.invalidateCache(ctx);
      ctx.log('info', `UniFi ${kind} ${resourceId}: ${actionId} — ${message}`);
      return { ok: true, message };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('warn', `UniFi ${kind} ${resourceId} ${actionId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const api = this.apiFor(ctx);
    try {
      if (operationId === 'port-power-cycle') {
        if (!resourceId) return { ok: false, message: 'Pick a device.' };
        const port = Number(values.port);
        if (!Number.isInteger(port) || port < 1) return { ok: false, message: 'Pick a port.' };
        const snap = await this.snapshot(ctx);
        const d = snap.devices.find((x) => x.mac.toLowerCase() === resourceId.toLowerCase());
        const p = d?.port_table?.find((x) => x.port_idx === port);
        if (p && p.port_poe === false) return { ok: false, message: `Port ${port} doesn't supply PoE.` };
        await api.powerCyclePort(resourceId, port);
        this.invalidateCache(ctx);
        return { ok: true, message: `Power-cycled PoE on port ${port}${d ? ` of ${deviceName(d)}` : ''}.` };
      }
      if (operationId === 'archive-all-alarms') {
        if ((await api.alarms()) === null) {
          return { ok: false, message: 'This firmware has no archivable alarms: the Alarms tab shows high-severity system-log entries instead.' };
        }
        await api.archiveAllAlarms();
        this.invalidateCache(ctx);
        return { ok: true, message: 'All alarms archived.' };
      }
      if (operationId === 'speedtest') {
        onProgress('Starting speed test on the gateway…');
        const before = (await this.snapshot(ctx, true));
        const lastRun = this.gatewayOf(before)?.['speedtest-status']?.rundate ?? this.sub(before, 'www')?.speedtest_lastrun ?? 0;
        await api.runSpeedTest();
        // Poll for the result: the gateway updates rundate when the test finishes (~30–60s).
        for (let i = 0; i < 24; i++) {
          if (signal?.aborted) return { ok: false, message: 'Cancelled.' };
          await new Promise((r) => setTimeout(r, 5000));
          onProgress(`Running speed test… ${(i + 1) * 5}s`);
          const snap = await this.snapshot(ctx, true).catch(() => undefined);
          if (!snap) continue;
          const st = this.gatewayOf(snap)?.['speedtest-status'];
          const www = this.sub(snap, 'www');
          const run = st?.rundate ?? www?.speedtest_lastrun ?? 0;
          if (run > lastRun) {
            const down = num(st?.xput_download) ?? num(www?.xput_down);
            const up = num(st?.xput_upload) ?? num(www?.xput_up);
            const ping = num(st?.latency) ?? num(www?.speedtest_ping);
            return {
              ok: true,
              message: `Speed test: ${down != null ? round(down, 1) : '?'} Mbps down, ${up != null ? round(up, 1) : '?'} Mbps up${ping != null ? `, ${ping} ms ping` : ''}.`,
              data: { downMbps: down, upMbps: up, pingMs: ping },
            };
          }
        }
        return { ok: true, message: 'Speed test started; the result will show on the WAN tiles when the gateway finishes.' };
      }
      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof UniApiError || err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('warn', `UniFi ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }
}

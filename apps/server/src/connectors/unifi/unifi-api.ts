import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

/** Cap a buffered HTTP response body so a hostile/compromised host can't OOM us. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** How long a username/password login session is reused before logging in again. */
const SESSION_TTL_MS = 30 * 60_000;

export interface UniAuth {
  /** e.g. "https://192.168.1.1" — the UniFi OS console origin. */
  baseUrl: string;
  /** UniFi OS API key (X-API-KEY). Preferred. */
  apiKey?: string;
  /** Local admin username/password — the alternative to an API key. */
  username?: string;
  password?: string;
  /** Network application site name (the short id, usually "default"). */
  site: string;
  /** Verify the TLS certificate (UniFi consoles ship a self-signed one). */
  verifyTls: boolean;
}

export class UniApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

// ── Response shapes (classic Network application API) ───────────────────────
// Every field is optional: UniFi changes these between releases and device types,
// so a missing field degrades a value to "—" instead of breaking a list.

export interface UniHealthSubsystem {
  subsystem: string; // wan | www | lan | wlan | vpn
  status?: string; // ok | warning | error | unknown
  num_user?: number;
  num_guest?: number;
  num_iot?: number;
  num_adopted?: number;
  num_disconnected?: number;
  num_pending?: number;
  num_disabled?: number;
  num_ap?: number;
  num_sw?: number;
  num_gw?: number;
  'tx_bytes-r'?: number;
  'rx_bytes-r'?: number;
  wan_ip?: string;
  isp_name?: string;
  isp_organization?: string;
  gw_name?: string;
  gw_mac?: string;
  gw_version?: string;
  'gw_system-stats'?: { cpu?: string | number; mem?: string | number; uptime?: string | number };
  latency?: number;
  uptime?: number;
  drops?: number;
  xput_up?: number;
  xput_down?: number;
  speedtest_status?: string;
  speedtest_lastrun?: number;
  speedtest_ping?: number;
  remote_user_enabled?: boolean;
  remote_user_num_active?: number;
  site_to_site_enabled?: boolean;
  nameservers?: string[];
  netmask?: string;
  uptime_stats?: Record<string, { availability?: number; latency_average?: number; time_period?: number }>;
}

export interface UniSysinfo {
  name?: string;
  hostname?: string;
  version?: string;
  build?: string;
  timezone?: string;
  uptime?: number;
  ubnt_device_type?: string;
  udm_version?: string;
  console_display_version?: string;
  update_available?: boolean;
  previous_version?: string;
}

export interface UniPort {
  port_idx?: number;
  name?: string;
  up?: boolean;
  enable?: boolean;
  speed?: number;
  full_duplex?: boolean;
  media?: string;
  is_uplink?: boolean;
  port_poe?: boolean;
  poe_enable?: boolean;
  poe_mode?: string;
  poe_power?: string | number;
  poe_voltage?: string | number;
  poe_class?: string;
  rx_bytes?: number;
  tx_bytes?: number;
  'rx_bytes-r'?: number;
  'tx_bytes-r'?: number;
  rx_errors?: number;
  tx_errors?: number;
  rx_dropped?: number;
  tx_dropped?: number;
  stp_state?: string;
  satisfaction?: number;
  lldp_table?: { lldp_system_name?: string; lldp_port_id?: string }[];
}

export interface UniRadioStats {
  name?: string;
  radio?: string; // ng | na | 6e
  channel?: number;
  tx_power?: number;
  num_sta?: number;
  cu_total?: number;
  satisfaction?: number;
  tx_retries?: number;
}

export interface UniWan {
  up?: boolean;
  enable?: boolean;
  ip?: string;
  name?: string;
  ifname?: string;
  speed?: number;
  full_duplex?: boolean;
  gateway?: string;
  netmask?: string;
  'rx_bytes-r'?: number;
  'tx_bytes-r'?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  latency?: number;
  max_speed?: number;
  type?: string;
}

export interface UniTemperature {
  name?: string;
  type?: string;
  value?: number;
}

export interface UniStorage {
  mount_point?: string;
  name?: string;
  size?: number;
  used?: number;
  type?: string;
}

export interface UniDevice {
  _id: string;
  mac: string;
  name?: string;
  model?: string;
  model_name?: string;
  shortname?: string;
  type?: string; // uap | usw | ugw | udm | uxg | ...
  state?: number | string;
  adopted?: boolean;
  version?: string;
  upgradable?: boolean;
  upgrade_to_firmware?: string;
  uptime?: number;
  ip?: string;
  serial?: string;
  last_seen?: number;
  'system-stats'?: { cpu?: string | number; mem?: string | number; uptime?: string | number };
  sys_stats?: { loadavg_1?: string | number; mem_total?: number; mem_used?: number };
  general_temperature?: number;
  has_temperature?: boolean;
  temperatures?: UniTemperature[];
  has_fan?: boolean;
  fan_level?: number;
  num_sta?: number;
  'user-num_sta'?: number;
  'guest-num_sta'?: number;
  tx_bytes?: number;
  rx_bytes?: number;
  'tx_bytes-r'?: number;
  'rx_bytes-r'?: number;
  satisfaction?: number;
  port_table?: UniPort[];
  radio_table_stats?: UniRadioStats[];
  wan1?: UniWan;
  wan2?: UniWan;
  uplink?: { type?: string; uplink_mac?: string; uplink_remote_port?: number; speed?: number; name?: string; up?: boolean };
  storage?: UniStorage[];
  total_max_power?: number;
  'speedtest-status'?: { xput_download?: number; xput_upload?: number; latency?: number; rundate?: number; status_summary?: number };
  uptime_stats?: Record<string, { availability?: number; latency_average?: number }>;
  active_geo_info?: Record<string, { isp_name?: string; isp_organization?: string; city?: string; country_name?: string }>;
  led_override?: string;
  locating?: boolean;
  /** Set by the Integration-API fallback, which reports states as strings. */
  _source?: 'integration';
}

export interface UniClient {
  _id?: string;
  mac: string;
  hostname?: string;
  name?: string;
  ip?: string;
  oui?: string;
  is_wired?: boolean;
  is_guest?: boolean;
  essid?: string;
  ap_mac?: string;
  sw_mac?: string;
  sw_port?: number;
  network?: string;
  vlan?: number;
  signal?: number;
  rssi?: number;
  channel?: number;
  radio?: string;
  radio_proto?: string;
  tx_rate?: number;
  rx_rate?: number;
  tx_bytes?: number;
  rx_bytes?: number;
  'tx_bytes-r'?: number;
  'rx_bytes-r'?: number;
  uptime?: number;
  first_seen?: number;
  last_seen?: number;
  satisfaction?: number;
  blocked?: boolean;
  use_fixedip?: boolean;
  fixed_ip?: string;
  uplink_mac?: string;
  /** Newer firmware: the last device/port a wired client was seen behind (also set behind unmanaged switches). */
  last_uplink_mac?: string;
  last_uplink_name?: string;
  last_uplink_remote_port?: number;
  /** Last known IP when `ip` is empty (e.g. a client that hasn't renewed recently). */
  last_ip?: string;
  display_name?: string;
}

/** A known (historic) client from rest/user — used for the blocked list. */
export interface UniKnownClient {
  _id: string;
  mac: string;
  name?: string;
  hostname?: string;
  oui?: string;
  blocked?: boolean;
  last_seen?: number;
  first_seen?: number;
  is_wired?: boolean;
  is_guest?: boolean;
  use_fixedip?: boolean;
  fixed_ip?: string;
  note?: string;
}

export interface UniNetwork {
  _id: string;
  name?: string;
  purpose?: string; // corporate | guest | wan | vlan-only | remote-user-vpn | site-vpn
  enabled?: boolean;
  vlan?: number | string;
  vlan_enabled?: boolean;
  ip_subnet?: string;
  dhcpd_enabled?: boolean;
  dhcpd_start?: string;
  dhcpd_stop?: string;
  domain_name?: string;
  networkgroup?: string;
  wan_type?: string;
  wan_networkgroup?: string;
  igmp_snooping?: boolean;
}

export interface UniWlan {
  _id: string;
  name?: string;
  enabled?: boolean;
  security?: string;
  wpa_mode?: string;
  wpa3_support?: boolean;
  is_guest?: boolean;
  hide_ssid?: boolean;
  networkconf_id?: string;
  wlan_band?: string;
  wlan_bands?: string[];
  usergroup_id?: string;
  mac_filter_enabled?: boolean;
}

export interface UniPortForward {
  _id: string;
  name?: string;
  enabled?: boolean;
  proto?: string;
  src?: string;
  dst_port?: string;
  fwd?: string;
  fwd_port?: string;
  pfwd_interface?: string;
  log?: boolean;
}

export interface UniAlarm {
  _id: string;
  key?: string;
  msg?: string;
  time?: number;
  datetime?: string;
  archived?: boolean;
  subsystem?: string;
  site_id?: string;
}

export interface UniEvent {
  _id: string;
  key?: string;
  msg?: string;
  time?: number;
  datetime?: string;
  subsystem?: string;
  severity?: string;
  subcategory?: string;
}

/** One entry from the v2 system log (`system-log/all`). */
export interface UniSystemLogEntry {
  id?: string;
  key?: string;
  event?: string;
  category?: string;
  subcategory?: string;
  severity?: string;
  timestamp?: number;
  title?: string;
  title_raw?: string;
  message?: string;
  message_raw?: string;
  parameters?: Record<string, { id?: string; name?: string } | undefined>;
}

export interface UniDdns {
  service?: string;
  hostname?: string;
  status?: string;
  current_ip?: string;
  last_changed?: number;
  interface?: string;
}

/** Classic firewall rule (`rest/firewallrule`) — pre-zone-based firewall. */
export interface UniFirewallRule {
  _id: string;
  name?: string;
  enabled?: boolean;
  action?: string; // accept | drop | reject
  ruleset?: string; // WAN_IN | WAN_OUT | WAN_LOCAL | LAN_IN | LAN_OUT | LAN_LOCAL | GUEST_* | *V6_*
  rule_index?: number;
  protocol?: string;
  protocol_match_excepted?: boolean;
  logging?: boolean;
  state_established?: boolean;
  state_related?: boolean;
  state_new?: boolean;
  state_invalid?: boolean;
  src_firewallgroup_ids?: string[];
  src_address?: string;
  src_mac_address?: string;
  src_networkconf_id?: string;
  src_networkconf_type?: string;
  src_port?: string;
  dst_firewallgroup_ids?: string[];
  dst_address?: string;
  dst_networkconf_id?: string;
  dst_networkconf_type?: string;
  dst_port?: string;
  ipsec?: string;
}

/** Address / port group referenced by firewall rules (`rest/firewallgroup`). */
export interface UniFirewallGroup {
  _id: string;
  name?: string;
  group_type?: string; // address-group | port-group | ipv6-address-group
  group_members?: string[];
}

/** Traffic rule (v2 `trafficrules`) — the "Traffic & Firewall Rules → Traffic rules" list. */
export interface UniTrafficRule {
  _id: string;
  description?: string;
  enabled?: boolean;
  action?: string; // BLOCK | ALLOW
  matching_target?: string; // INTERNET | IP | DOMAIN | APP | APP_CATEGORY | REGION
  target_devices?: { type?: string; client_mac?: string; network_id?: string }[];
  domains?: { domain?: string }[];
  ip_addresses?: { ip_or_subnet?: string; port_ranges?: unknown[]; ports?: unknown[] }[];
  ip_ranges?: { ip_start?: string; ip_stop?: string }[];
  regions?: string[];
  app_ids?: number[];
  app_category_ids?: number[];
  network_ids?: string[];
  bandwidth_limit?: { enabled?: boolean; download_limit_kbps?: number; upload_limit_kbps?: number };
  schedule?: { mode?: string; time_range_start?: string; time_range_end?: string; repeat_on_days?: string[] };
}

/** One side (source/destination) of a zone-based firewall policy. */
export interface UniPolicyEndpoint {
  zone_id?: string;
  matching_target?: string; // ANY | IP | NETWORK | CLIENT | REGION | DOMAIN | APP …
  matching_target_type?: string;
  ips?: string[];
  network_ids?: string[];
  client_macs?: string[];
  regions?: string[];
  web_domains?: string[];
  port?: string | number;
  port_matching_type?: string; // ANY | SPECIFIC | OBJECT
  match_opposite_ips?: boolean;
  match_opposite_ports?: boolean;
  ip_group_id?: string;
  port_group_id?: string;
}

/** Zone-based firewall policy (v2 `firewall-policies`). */
export interface UniFirewallPolicy {
  _id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  action?: string; // ALLOW | BLOCK | REJECT
  index?: number;
  predefined?: boolean;
  protocol?: string;
  ip_version?: string;
  logging?: boolean;
  connection_state_type?: string;
  connection_states?: string[];
  source?: UniPolicyEndpoint;
  destination?: UniPolicyEndpoint;
  schedule?: { mode?: string };
}

/** Firewall zone (v2 `firewall/zone`). */
export interface UniFirewallZone {
  _id: string;
  name?: string;
  zone_key?: string;
  network_ids?: string[];
}

interface Session {
  cookie: string;
  /** The password this session logged in with — a changed (or wrong) password never rides on it. */
  password: string;
  csrf?: string;
  at: number;
}

/** username/password sessions, shared across client instances (one per console + user). */
const sessions = new Map<string, Session>();

/** Integration-API state strings → the classic numeric device state codes. */
const INTEGRATION_STATE: Record<string, number> = {
  ONLINE: 1,
  OFFLINE: 0,
  PENDING_ADOPTION: 2,
  UPDATING: 4,
  GETTING_READY: 5,
  ADOPTING: 7,
  DELETING: 8,
  CONNECTION_INTERRUPTED: 6,
  ISOLATED: 11,
};

/**
 * UniFi Network client for a UniFi OS console (UDM / UDM Pro / UDM SE / UCG / UDR).
 *
 * Talks to the Network application's controller API through the console's reverse
 * proxy (`/proxy/network/api/s/<site>/…`) — the richest local surface (health, WAN,
 * per-port PoE, radios, clients, alarms, events, config). Auth is either an API key
 * (`X-API-KEY`) or a local admin login (`/api/auth/login` → TOKEN cookie + CSRF
 * header, cached and refreshed on 401).
 *
 * If a console's firmware accepts an API key only on the official Integration API
 * (`/proxy/network/integration/v1`), `devices()`/`clients()` fall back to it and the
 * richer classic-only data (health, alarms, config…) comes back empty.
 */
export class UniFiApi {
  /** Set once the classic API refused the API key and we've switched to the Integration API. */
  private integrationOnly = false;
  private integrationSiteId?: string;
  /** Set once the console answers the classic alarm list with HTTP 400 (alarms live in the system log). */
  private noClassicAlarms = false;

  constructor(private readonly auth: UniAuth) {}

  private get usesKey(): boolean {
    return !!this.auth.apiKey;
  }

  private sessionKey(): string {
    return `${this.auth.baseUrl}|${this.auth.username ?? ''}`;
  }

  private base(): string {
    return this.auth.baseUrl.replace(/\/+$/, '');
  }

  private sitePath(path: string): string {
    return `/proxy/network/api/s/${encodeURIComponent(this.auth.site || 'default')}/${path}`;
  }

  /** Low-level HTTP call. Returns status, headers, and the raw body. */
  private raw(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    const url = new URL(`${this.base()}${path}`);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload).toString();
    }
    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      rejectUnauthorized: isHttps ? this.auth.verifyTls : undefined,
      timeout: 20000,
    };
    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) return void req.destroy(new UniApiError('UniFi response exceeded the size limit.'));
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new UniApiError('Connection to the UniFi console timed out — check the address and that Cerebro can reach it on this port (firewall / VLAN rules).')));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof UniApiError) return reject(err);
        if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          reject(new UniApiError('The console uses a self-signed TLS certificate. Turn off "Verify TLS certificate", or install a trusted cert on the console.'));
        } else if (err.code === 'ECONNREFUSED') {
          reject(new UniApiError('Connection refused — check the console address and port.'));
        } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'EAI_NODATA') {
          reject(new UniApiError('Host not found — check the console address.'));
        } else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'ETIMEDOUT') {
          reject(new UniApiError('Console unreachable — Cerebro has no network path to it (check firewall / VLAN rules).'));
        } else {
          reject(new UniApiError(err.message));
        }
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Log in with username/password and cache the session cookie + CSRF token. */
  private async login(): Promise<Session> {
    if (!this.auth.username || !this.auth.password) {
      throw new UniApiError('No credentials — set an API key, or a local admin username and password.');
    }
    const res = await this.raw('POST', '/api/auth/login', {
      username: this.auth.username,
      password: this.auth.password,
      rememberMe: true,
    });
    if (res.status === 401 || res.status === 403) {
      throw new UniApiError('Login failed — check the username and password. Use a local admin account (not a ui.com cloud account with MFA).', res.status);
    }
    if (res.status === 429) throw new UniApiError('The console is rate-limiting logins — wait a minute and try again.', 429);
    if (res.status < 200 || res.status >= 300) throw new UniApiError(`Login returned HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status);
    const setCookie = res.headers['set-cookie'] ?? [];
    const cookie = setCookie.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    if (!cookie) throw new UniApiError('Login succeeded but the console returned no session cookie.');
    const csrf = (res.headers['x-csrf-token'] as string | undefined) ?? (res.headers['x-updated-csrf-token'] as string | undefined);
    const s: Session = { cookie, password: this.auth.password, csrf, at: Date.now() };
    sessions.set(this.sessionKey(), s);
    return s;
  }

  private async session(): Promise<Session> {
    const s = sessions.get(this.sessionKey());
    if (s && s.password === this.auth.password && Date.now() - s.at < SESSION_TTL_MS) return s;
    return this.login();
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.usesKey) return { 'X-API-KEY': this.auth.apiKey! };
    const s = await this.session();
    const h: Record<string, string> = { Cookie: s.cookie };
    if (s.csrf) h['X-CSRF-Token'] = s.csrf;
    return h;
  }

  /** Authenticated JSON request. Retries once after a fresh login when a session expires. */
  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.raw(method, path, body, await this.authHeaders());
    // A rotated CSRF token comes back on responses — keep the session in step.
    const updated = res.headers['x-updated-csrf-token'] as string | undefined;
    if (updated && !this.usesKey) {
      const s = sessions.get(this.sessionKey());
      if (s) s.csrf = updated;
    }
    if ((res.status === 401 || res.status === 403) && !this.usesKey && !retried) {
      sessions.delete(this.sessionKey());
      return this.request<T>(method, path, body, true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new UniApiError(
        this.usesKey
          ? 'The console rejected the API key — check it is valid and belongs to an admin with Network access.'
          : 'Not authorized — the account needs admin access to the Network application.',
        res.status,
      );
    }
    if (res.status === 404) throw new UniApiError(`Not found (${path}) — check the site name; this console may not run the Network application.`, 404);
    if (res.status < 200 || res.status >= 300) throw new UniApiError(`UniFi returned HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status);
    let parsed: unknown;
    try {
      parsed = res.body ? JSON.parse(res.body) : {};
    } catch {
      throw new UniApiError('Could not parse the UniFi response as JSON (is this a UniFi OS console?).');
    }
    // The classic API wraps everything in { meta: { rc: 'ok'|'error', msg }, data: [...] }.
    const meta = (parsed as { meta?: { rc?: string; msg?: string } }).meta;
    if (meta && meta.rc && meta.rc !== 'ok') {
      throw new UniApiError(`UniFi error: ${meta.msg ?? 'unknown'}${meta.msg === 'api.err.NoSiteContext' ? ' — check the site name' : ''}`);
    }
    return parsed as T;
  }

  /** GET a classic site endpoint and unwrap its `data` array. */
  private async siteGet<T>(path: string): Promise<T[]> {
    const r = await this.request<{ data?: T[] }>('GET', this.sitePath(path));
    return Array.isArray(r.data) ? r.data : [];
  }

  /** POST a classic site command (cmd/devmgr, cmd/stamgr, …). */
  private async siteCmd(manager: string, body: Record<string, unknown>): Promise<void> {
    await this.request('POST', this.sitePath(`cmd/${manager}`), body);
  }

  // ── Read paths ────────────────────────────────────────────────────────────

  /** Network application system info — version, hostname, uptime (cheap; used by the connection test). */
  async sysinfo(): Promise<UniSysinfo | undefined> {
    return (await this.siteGet<UniSysinfo>('stat/sysinfo'))[0];
  }

  /** Per-subsystem health: wan / www / lan / wlan / vpn. */
  async health(): Promise<UniHealthSubsystem[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniHealthSubsystem>('stat/health');
  }

  /** Every adopted device with full stats (ports, radios, WAN, temperatures…). */
  async devices(): Promise<UniDevice[]> {
    if (this.integrationOnly) return this.integrationDevices();
    try {
      return await this.siteGet<UniDevice>('stat/device');
    } catch (err) {
      if (this.canFallBack(err)) {
        this.integrationOnly = true;
        return this.integrationDevices();
      }
      throw err;
    }
  }

  /** Currently connected clients. */
  async clients(): Promise<UniClient[]> {
    if (this.integrationOnly) return this.integrationClients();
    try {
      return await this.siteGet<UniClient>('stat/sta');
    } catch (err) {
      if (this.canFallBack(err)) {
        this.integrationOnly = true;
        return this.integrationClients();
      }
      throw err;
    }
  }

  /** Every client the site has ever seen (rest/user) — used for the blocked list. */
  async knownClients(): Promise<UniKnownClient[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniKnownClient>('rest/user');
  }

  async networks(): Promise<UniNetwork[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniNetwork>('rest/networkconf');
  }

  async wlans(): Promise<UniWlan[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniWlan>('rest/wlanconf');
  }

  async portForwards(): Promise<UniPortForward[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniPortForward>('rest/portforward');
  }

  /** Active (un-archived) alarms. */
  /**
   * Active (un-archived) alarms, or `null` when this firmware has no classic alarm list.
   * Current UDM SE releases answer both `list/alarm` and `rest/alarm` with HTTP 400
   * api.err.InvalidObject: alarms were folded into the v2 system log there.
   */
  async alarms(): Promise<UniAlarm[] | null> {
    if (this.integrationOnly) return [];
    if (this.noClassicAlarms) return null;
    try {
      const all = await this.siteGet<UniAlarm>('list/alarm');
      return all.filter((a) => !a.archived);
    } catch (err) {
      if (err instanceof UniApiError && err.status === 400) {
        this.noClassicAlarms = true;
        return null;
      }
      throw err;
    }
  }

  /**
   * Recent events (last `hours`), newest first. Current Network releases dropped the
   * classic `stat/event` (it returns nothing) in favour of the v2 system log
   * (`POST /proxy/network/v2/api/site/<site>/system-log/all`); try that first and fall
   * back to `stat/event` on older firmware.
   */
  async events(hours = 24, limit = 200): Promise<UniEvent[]> {
    if (this.integrationOnly) return [];
    try {
      return await this.systemLog(hours, limit);
    } catch (err) {
      if (err instanceof UniApiError && err.status && err.status !== 404 && err.status !== 400) throw err;
      return this.siteGet<UniEvent>(`stat/event?within=${hours}&_limit=${limit}&_sort=-time`);
    }
  }

  private async systemLog(hours: number, limit: number): Promise<UniEvent[]> {
    const to = Date.now();
    const from = to - hours * 3_600_000;
    const pageSize = 500;
    const raw: UniSystemLogEntry[] = [];
    for (let page = 0; page < 4; page++) {
      const r = await this.request<{ data?: UniSystemLogEntry[]; total_page_count?: number }>(
        'POST',
        `/proxy/network/v2/api/site/${encodeURIComponent(this.auth.site || 'default')}/system-log/all`,
        { timestampFrom: from, timestampTo: to, pageNumber: page, pageSize },
      );
      if (!Array.isArray(r.data)) throw new UniApiError('system-log: no data array in response', 404);
      raw.push(...r.data);
      if (page + 1 >= (r.total_page_count ?? 0)) break;
    }
    return raw
      .map((e) => {
        // Messages are templates like "{CLIENT} connected to {WLAN}"; fill them from `parameters`.
        const template = e.message ?? e.message_raw ?? e.title ?? e.title_raw ?? e.key ?? '';
        const msg = template.replace(/\{([A-Z0-9_]+)\}/g, (whole, k: string) => e.parameters?.[k]?.name ?? e.parameters?.[k]?.id ?? whole);
        return {
          _id: e.id ?? `${e.key}:${e.timestamp}`,
          key: e.key ?? e.event,
          msg,
          time: e.timestamp,
          subsystem: e.category,
          severity: e.severity,
          subcategory: e.subcategory,
        } satisfies UniEvent;
      })
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      .slice(0, limit);
  }

  // ── Firewall (read-only) ──────────────────────────────────────────────────

  /** GET a v2 site endpoint; `null` when this firmware doesn't have it (400/404). */
  private async v2Get<T>(path: string): Promise<T[] | null> {
    try {
      const r = await this.request<unknown>('GET', `/proxy/network/v2/api/site/${encodeURIComponent(this.auth.site || 'default')}/${path}`);
      if (Array.isArray(r)) return r as T[];
      const data = (r as { data?: unknown }).data;
      return Array.isArray(data) ? (data as T[]) : [];
    } catch (err) {
      if (err instanceof UniApiError && (err.status === 400 || err.status === 404 || err.status === 405)) return null;
      throw err;
    }
  }

  /** Classic GET that yields `null` instead of failing when the endpoint is gone. */
  private async siteGetOptional<T>(path: string): Promise<T[] | null> {
    try {
      return await this.siteGet<T>(path);
    } catch (err) {
      if (err instanceof UniApiError && (err.status === 400 || err.status === 404)) return null;
      throw err;
    }
  }

  /** Classic (pre-zone) firewall rules; `null` if the firmware no longer serves them. */
  async firewallRules(): Promise<UniFirewallRule[] | null> {
    if (this.integrationOnly) return null;
    return this.siteGetOptional<UniFirewallRule>('rest/firewallrule');
  }

  async firewallGroups(): Promise<UniFirewallGroup[] | null> {
    if (this.integrationOnly) return null;
    return this.siteGetOptional<UniFirewallGroup>('rest/firewallgroup');
  }

  async trafficRules(): Promise<UniTrafficRule[] | null> {
    if (this.integrationOnly) return null;
    return this.v2Get<UniTrafficRule>('trafficrules');
  }

  /** Zone-based firewall policies (Network 9+); `null` when the firmware has none. */
  async firewallPolicies(): Promise<UniFirewallPolicy[] | null> {
    if (this.integrationOnly) return null;
    return this.v2Get<UniFirewallPolicy>('firewall-policies');
  }

  async firewallZones(): Promise<UniFirewallZone[] | null> {
    if (this.integrationOnly) return null;
    return this.v2Get<UniFirewallZone>('firewall/zone');
  }

  async dynamicDns(): Promise<UniDdns[]> {
    if (this.integrationOnly) return [];
    return this.siteGet<UniDdns>('stat/dynamicdns');
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private requireClassic(what: string): void {
    if (this.integrationOnly) {
      throw new UniApiError(`${what} needs the full controller API, which this console doesn't allow with an API key — use a local admin username/password instead.`);
    }
  }

  async restartDevice(mac: string): Promise<void> {
    this.requireClassic('Restarting a device');
    await this.siteCmd('devmgr', { cmd: 'restart', mac: mac.toLowerCase(), reboot_type: 'soft' });
  }

  async locateDevice(mac: string, on: boolean): Promise<void> {
    this.requireClassic('Locate');
    await this.siteCmd('devmgr', { cmd: on ? 'set-locate' : 'unset-locate', mac: mac.toLowerCase() });
  }

  async upgradeDevice(mac: string): Promise<void> {
    this.requireClassic('Firmware upgrade');
    await this.siteCmd('devmgr', { cmd: 'upgrade', mac: mac.toLowerCase() });
  }

  async powerCyclePort(mac: string, portIdx: number): Promise<void> {
    this.requireClassic('PoE power-cycle');
    await this.siteCmd('devmgr', { cmd: 'power-cycle', mac: mac.toLowerCase(), port_idx: portIdx });
  }

  async runSpeedTest(): Promise<void> {
    this.requireClassic('Speed test');
    await this.siteCmd('devmgr', { cmd: 'speedtest' });
  }

  async kickClient(mac: string): Promise<void> {
    this.requireClassic('Reconnecting a client');
    await this.siteCmd('stamgr', { cmd: 'kick-sta', mac: mac.toLowerCase() });
  }

  async blockClient(mac: string, block: boolean): Promise<void> {
    this.requireClassic('Blocking a client');
    await this.siteCmd('stamgr', { cmd: block ? 'block-sta' : 'unblock-sta', mac: mac.toLowerCase() });
  }

  async archiveAlarm(id: string): Promise<void> {
    this.requireClassic('Archiving an alarm');
    await this.siteCmd('evtmgr', { cmd: 'archive-alarm', _id: id });
  }

  async archiveAllAlarms(): Promise<void> {
    this.requireClassic('Archiving alarms');
    await this.siteCmd('evtmgr', { cmd: 'archive-all-alarms' });
  }

  async setWlanEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireClassic('Changing a Wi-Fi network');
    await this.request('PUT', this.sitePath(`rest/wlanconf/${encodeURIComponent(id)}`), { enabled });
  }

  async setPortForwardEnabled(id: string, enabled: boolean): Promise<void> {
    this.requireClassic('Changing a port forward');
    await this.request('PUT', this.sitePath(`rest/portforward/${encodeURIComponent(id)}`), { enabled });
  }

  // ── Integration API fallback (API key on firmware that limits keys to it) ───

  private canFallBack(err: unknown): boolean {
    return this.usesKey && err instanceof UniApiError && (err.status === 401 || err.status === 403);
  }

  private async integrationGet<T>(path: string): Promise<T> {
    const res = await this.raw('GET', `/proxy/network/integration/v1${path}`, undefined, await this.authHeaders());
    if (res.status === 401 || res.status === 403) {
      throw new UniApiError('The console rejected the API key — check it is valid and belongs to an admin with Network access.', res.status);
    }
    if (res.status < 200 || res.status >= 300) throw new UniApiError(`UniFi Integration API returned HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new UniApiError('Could not parse the UniFi Integration API response as JSON.');
    }
  }

  /** Follow the Integration API's { offset, limit, count, totalCount, data } pages. */
  private async integrationList<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const limit = 200;
    for (let offset = 0; offset < 10_000; offset += limit) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.integrationGet<{ data?: T[]; totalCount?: number; count?: number }>(`${path}${sep}offset=${offset}&limit=${limit}`);
      const data = Array.isArray(page.data) ? page.data : [];
      out.push(...data);
      if (data.length < limit || (page.totalCount != null && out.length >= page.totalCount)) break;
    }
    return out;
  }

  private async integrationSite(): Promise<string> {
    if (this.integrationSiteId) return this.integrationSiteId;
    const sites = await this.integrationList<{ id: string; internalReference?: string; name?: string }>('/sites');
    const want = this.auth.site || 'default';
    const site = sites.find((s) => s.internalReference === want) ?? sites.find((s) => s.name === want) ?? sites[0];
    if (!site) throw new UniApiError('The API key can see no sites.');
    this.integrationSiteId = site.id;
    return site.id;
  }

  private async integrationDevices(): Promise<UniDevice[]> {
    const site = await this.integrationSite();
    type IDev = { id: string; name?: string; model?: string; macAddress?: string; ipAddress?: string; state?: string; firmwareVersion?: string; firmwareUpdatable?: boolean; features?: string[] };
    const list = await this.integrationList<IDev>(`/sites/${site}/devices`);
    const stats = await Promise.all(
      list.map((d) =>
        this.integrationGet<{ uptimeSec?: number; cpuUtilizationPct?: number; memoryUtilizationPct?: number }>(`/sites/${site}/devices/${d.id}/statistics/latest`).catch(() => undefined),
      ),
    );
    return list.map((d, i) => {
      const st = stats[i];
      const features = d.features ?? [];
      const type = /UDM|UCG|UDR|UXG|USG|Dream|Gateway/i.test(d.model ?? '') ? 'udm' : features.includes('accessPoint') ? 'uap' : features.includes('switching') ? 'usw' : undefined;
      return {
        _id: d.id,
        mac: d.macAddress ?? d.id,
        name: d.name,
        model: d.model,
        type,
        state: INTEGRATION_STATE[(d.state ?? '').toUpperCase()] ?? d.state,
        version: d.firmwareVersion,
        upgradable: d.firmwareUpdatable,
        ip: d.ipAddress,
        uptime: st?.uptimeSec,
        'system-stats': st ? { cpu: st.cpuUtilizationPct, mem: st.memoryUtilizationPct } : undefined,
        _source: 'integration',
      } satisfies UniDevice;
    });
  }

  private async integrationClients(): Promise<UniClient[]> {
    const site = await this.integrationSite();
    type ICli = { id: string; name?: string; type?: string; macAddress?: string; ipAddress?: string; connectedAt?: string; uplinkDeviceId?: string };
    const list = await this.integrationList<ICli>(`/sites/${site}/clients`);
    return list.map((c) => ({
      _id: c.id,
      mac: c.macAddress ?? c.id,
      name: c.name,
      ip: c.ipAddress,
      is_wired: (c.type ?? '').toUpperCase() === 'WIRED',
      uptime: c.connectedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(c.connectedAt)) / 1000)) : undefined,
      uplink_mac: c.uplinkDeviceId,
    }));
  }

  /** True once this client has fallen back to the Integration API. */
  get limited(): boolean {
    return this.integrationOnly;
  }
}

import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailGroup,
  ConnectorDetailItem,
  ConnectorOverview,
  OperationResult,
  OperationProgress,
  TestConnectionResult,
} from '@cerebro/shared';
import { HaApi, HaAuth, HaState } from './ha-api';

/** Battery percentage at or below which an entity counts as "low" in the health overview. */
const LOW_BATTERY_PCT = 20;

/** States that mean an entity is effectively dead / not reporting. */
const DEAD_STATES = new Set(['unavailable', 'unknown']);

/**
 * Maps a (kind, actionId) to the underlying Home Assistant service name. The service's
 * domain is always the kind, so `light` + `toggle` → POST /api/services/light/toggle.
 */
const SERVICE_MAP: Record<string, Record<string, string>> = {
  light: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle' },
  switch: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle' },
  lock: { lock: 'lock', unlock: 'unlock' },
  cover: { open: 'open_cover', close: 'close_cover', stop: 'stop_cover' },
  media_player: { play: 'media_play', pause: 'media_pause', next: 'media_next_track', previous: 'media_previous_track' },
  automation: { enable: 'turn_on', disable: 'turn_off', trigger: 'trigger' },
  scene: { activate: 'turn_on' },
  script: { run: 'turn_on', stop: 'turn_off' },
};

/**
 * Resource kinds. Each maps 1:1 to a Home Assistant entity domain (the part of the
 * entity_id before the dot). Actions call the matching HA service (see SERVICE_MAP);
 * parameterized controls (climate/light/volume) are operations below.
 */
const KINDS: ConnectorResourceKind[] = [
  {
    id: 'light',
    label: 'Lights',
    deletable: false,
    actions: [
      { id: 'turn_on', label: 'On', mutating: true, showWhenStatus: ['off'] },
      { id: 'turn_off', label: 'Off', mutating: true, showWhenStatus: ['on'] },
      { id: 'toggle', label: 'Toggle', mutating: true, showWhenStatus: ['on', 'off'] },
    ],
  },
  {
    id: 'switch',
    label: 'Switches',
    deletable: false,
    actions: [
      { id: 'turn_on', label: 'On', mutating: true, showWhenStatus: ['off'] },
      { id: 'turn_off', label: 'Off', mutating: true, showWhenStatus: ['on'] },
      { id: 'toggle', label: 'Toggle', mutating: true, showWhenStatus: ['on', 'off'] },
    ],
  },
  { id: 'climate', label: 'Climate', deletable: false, actions: [] }, // controlled via the "Set temperature" operation
  {
    id: 'lock',
    label: 'Locks',
    deletable: false,
    actions: [
      { id: 'lock', label: 'Lock', mutating: true, showWhenStatus: ['unlocked'] },
      { id: 'unlock', label: 'Unlock', mutating: true, intent: 'destructive', confirm: 'Unlock this lock?', showWhenStatus: ['locked'] },
    ],
  },
  {
    id: 'cover',
    label: 'Covers',
    deletable: false,
    actions: [
      { id: 'open', label: 'Open', mutating: true, showWhenStatus: ['closed'] },
      { id: 'close', label: 'Close', mutating: true, showWhenStatus: ['open'] },
      { id: 'stop', label: 'Stop', mutating: true, showWhenStatus: ['opening', 'closing'] },
    ],
  },
  { id: 'sensor', label: 'Sensors', deletable: false, actions: [] },
  { id: 'binary_sensor', label: 'Binary Sensors', deletable: false, actions: [] },
  {
    id: 'media_player',
    label: 'Media Players',
    deletable: false,
    actions: [
      { id: 'play', label: 'Play', mutating: true, showWhenStatus: ['paused', 'idle'] },
      { id: 'pause', label: 'Pause', mutating: true, showWhenStatus: ['playing'] },
      { id: 'previous', label: 'Previous', mutating: true, showWhenStatus: ['playing', 'paused'] },
      { id: 'next', label: 'Next', mutating: true, showWhenStatus: ['playing', 'paused'] },
    ],
  },
  {
    id: 'automation',
    label: 'Automations',
    deletable: false,
    actions: [
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['off'] },
      { id: 'disable', label: 'Disable', mutating: true, showWhenStatus: ['on'] },
      { id: 'trigger', label: 'Run now', mutating: true, confirm: 'Run this automation now?', showWhenStatus: ['on', 'off'] },
    ],
  },
  {
    id: 'scene',
    label: 'Scenes',
    deletable: false,
    // A scene's state is the last-activated timestamp, not on/off — so Activate always shows.
    actions: [{ id: 'activate', label: 'Activate', mutating: true }],
  },
  {
    id: 'script',
    label: 'Scripts',
    deletable: false,
    actions: [
      { id: 'run', label: 'Run', mutating: true, showWhenStatus: ['off'] },
      { id: 'stop', label: 'Stop', mutating: true, showWhenStatus: ['on'] },
    ],
  },
];

const KIND_IDS = new Set(KINDS.map((k) => k.id));

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function strOrUndef(v: unknown): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return s ? s : undefined;
}

/** The entity domain (e.g. "light" from "light.kitchen"). */
function domainOf(entityId: string): string {
  return entityId.split('.')[0] ?? '';
}

/** Best-effort relative-time label for an ISO timestamp. */
function rel(iso?: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The entity's battery percentage, if it reports one — either a `battery` device-class
 * sensor whose state is the percentage, or any entity carrying a `battery_level` attribute.
 * Returns null when there's no battery reading.
 */
function batteryPct(s: HaState): number | null {
  const a = s.attributes ?? {};
  if (a.device_class === 'battery' && (a.unit_of_measurement === '%' || a.unit_of_measurement === undefined)) {
    const n = Number(s.state);
    if (Number.isFinite(n)) return n;
  }
  if (a.battery_level != null) {
    const n = Number(a.battery_level);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export class HomeAssistantConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'home-assistant',
    name: 'Home Assistant',
    description: 'Monitor and control a Home Assistant instance — entity health plus lights, switches, locks, covers, climate, media, automations, and scenes.',
    version: '0.2.0',
    icon: 'home-assistant',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'url',
        required: true,
        placeholder: 'https://ha.example.com',
        help: 'The Home Assistant URL, including the port if not 443/80.',
      },
      {
        key: 'token',
        label: 'Long-lived access token',
        type: 'password',
        secret: true,
        required: true,
        help: 'Home Assistant → your profile → Long-Lived Access Tokens → Create Token.',
      },
      {
        key: 'verifyTls',
        label: 'Verify TLS certificate',
        type: 'boolean',
        default: true,
        help: 'Turn off only if Home Assistant uses a self-signed certificate.',
      },
    ],
    resourceKinds: KINDS,
    operations: [
      {
        id: 'climate-set',
        label: 'Set temperature',
        description: 'Set the target temperature and/or mode for this thermostat.',
        scope: 'resource',
        kind: 'climate',
        icon: 'thermometer',
        submitLabel: 'Apply',
        prefill: true,
        fields: [
          { key: 'temperature', label: 'Target temperature', type: 'number', help: 'In your Home Assistant unit (°F/°C). Leave blank to only change the mode.' },
          {
            key: 'hvac_mode',
            label: 'Mode',
            type: 'select',
            options: [
              { label: '(unchanged)', value: '' },
              { label: 'Heat', value: 'heat' },
              { label: 'Cool', value: 'cool' },
              { label: 'Heat/Cool', value: 'heat_cool' },
              { label: 'Auto', value: 'auto' },
              { label: 'Dry', value: 'dry' },
              { label: 'Fan only', value: 'fan_only' },
              { label: 'Off', value: 'off' },
            ],
          },
        ],
      },
      {
        id: 'light-set',
        label: 'Set brightness',
        description: 'Adjust this light\'s brightness and, optionally, color temperature.',
        scope: 'resource',
        kind: 'light',
        icon: 'sun',
        submitLabel: 'Apply',
        prefill: true,
        fields: [
          { key: 'brightness_pct', label: 'Brightness %', type: 'number', help: '0–100.' },
          { key: 'color_temp_kelvin', label: 'Color temperature (K)', type: 'number', help: 'Optional — e.g. 2700 (warm) to 6500 (cool).' },
        ],
      },
      {
        id: 'media-volume',
        label: 'Set volume',
        description: 'Set the volume level for this media player.',
        scope: 'resource',
        kind: 'media_player',
        icon: 'volume-2',
        submitLabel: 'Apply',
        prefill: true,
        fields: [{ key: 'volume_pct', label: 'Volume %', type: 'number', help: '0–100.' }],
      },
    ],
    help: {
      overview:
        'Monitor and control Home Assistant: browse entities by domain, see a health summary (unavailable entities, low batteries, pending updates), and operate lights, switches, locks, covers, climate, media, automations, and scenes.',
      setupSteps: [
        'In Home Assistant, open your profile (bottom-left avatar).',
        'Scroll to "Long-Lived Access Tokens" and choose "Create Token".',
        'Copy the token (shown once) and paste it here.',
        'Enter your Home Assistant base URL, including the port if it is not the default.',
      ],
      requiredPermissions: [
        'A long-lived access token whose user can call services on the entities you want to control (an admin user can control everything).',
      ],
      referenceLinks: [
        { label: 'Home Assistant REST API', url: 'https://developers.home-assistant.io/docs/api/rest/' },
        { label: 'Long-lived access tokens', url: 'https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token' },
      ],
      notes:
        'Integration setup-failure counts and room/area grouping require the Home Assistant WebSocket API and are planned for a later phase.',
    },
  };

  private authFrom(ctx: ConnectorContext): HaAuth {
    const c = ctx.config;
    return {
      baseUrl: String(c.baseUrl ?? ''),
      token: String(c.token ?? ''),
      // Default ON for HA (unlike Proxmox) — most instances have a real cert.
      verifyTls: c.verifyTls !== false && c.verifyTls !== 'false',
    };
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = new HaApi(this.authFrom(ctx));
    try {
      const cfg = await api.config();
      ctx.log('info', `Connected to Home Assistant ${cfg.version}`);
      const where = cfg.location_name ? ` (${cfg.location_name})` : '';
      return { ok: true, message: `Connected to Home Assistant ${cfg.version}${where}.`, details: { version: cfg.version } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Home Assistant connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async performAction(
    ctx: ConnectorContext,
    kind: string,
    resourceId: string,
    actionId: string,
  ): Promise<{ ok: boolean; message: string }> {
    const service = SERVICE_MAP[kind]?.[actionId];
    if (!service) return { ok: false, message: `Unsupported action "${actionId}" for ${kind}.` };
    const api = new HaApi(this.authFrom(ctx));
    try {
      // The service domain is the entity domain (== kind); target by entity_id.
      await api.callService(kind, service, { entity_id: resourceId });
      ctx.log('info', `Home Assistant ${kind}.${service} on ${resourceId} requested.`);
      return { ok: true, message: `${actionId.replace(/_/g, ' ')} requested for ${resourceId}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `Home Assistant ${kind}.${service} on ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async operationDefaults(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    _values: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!resourceId) return {};
    const api = new HaApi(this.authFrom(ctx));
    const all = await api.states();
    const s = all.find((e) => e.entity_id === resourceId);
    if (!s) return {};
    const a = s.attributes ?? {};

    if (operationId === 'climate-set') {
      const d: Record<string, unknown> = {};
      if (a.temperature != null) d.temperature = a.temperature;
      if (!DEAD_STATES.has(s.state)) d.hvac_mode = s.state; // a thermostat's state IS its hvac mode
      return d;
    }
    if (operationId === 'light-set') {
      const d: Record<string, unknown> = {};
      if (a.brightness != null) d.brightness_pct = Math.round((Number(a.brightness) / 255) * 100);
      if (a.color_temp_kelvin != null) d.color_temp_kelvin = a.color_temp_kelvin;
      return d;
    }
    if (operationId === 'media-volume') {
      return a.volume_level != null ? { volume_pct: Math.round(Number(a.volume_level) * 100) } : {};
    }
    return {};
  }

  async runOperation(
    ctx: ConnectorContext,
    operationId: string,
    resourceId: string | undefined,
    values: Record<string, unknown>,
    onProgress: OperationProgress,
  ): Promise<OperationResult> {
    if (!resourceId) return { ok: false, message: 'No target entity.' };
    const api = new HaApi(this.authFrom(ctx));
    try {
      if (operationId === 'climate-set') {
        const temp = numOrUndef(values.temperature);
        const mode = strOrUndef(values.hvac_mode);
        if (temp === undefined && !mode) return { ok: false, message: 'Set a temperature or a mode.' };
        if (mode) {
          onProgress(`Setting mode to ${mode}…`);
          await api.callService('climate', 'set_hvac_mode', { entity_id: resourceId, hvac_mode: mode });
        }
        if (temp !== undefined) {
          onProgress(`Setting temperature to ${temp}°…`);
          await api.callService('climate', 'set_temperature', { entity_id: resourceId, temperature: temp });
        }
        return { ok: true, message: 'Climate updated.' };
      }
      if (operationId === 'light-set') {
        const pct = numOrUndef(values.brightness_pct);
        const kelvin = numOrUndef(values.color_temp_kelvin);
        if (pct === undefined && kelvin === undefined) return { ok: false, message: 'Set a brightness or color temperature.' };
        if (pct !== undefined && (pct < 0 || pct > 100)) return { ok: false, message: 'Brightness must be 0–100.' };
        const data: Record<string, unknown> = { entity_id: resourceId };
        if (pct !== undefined) data.brightness_pct = pct;
        if (kelvin !== undefined) data.color_temp_kelvin = kelvin;
        onProgress('Applying light settings…');
        await api.callService('light', 'turn_on', data);
        return { ok: true, message: 'Light updated.' };
      }
      if (operationId === 'media-volume') {
        const pct = numOrUndef(values.volume_pct);
        if (pct === undefined) return { ok: false, message: 'Set a volume.' };
        if (pct < 0 || pct > 100) return { ok: false, message: 'Volume must be 0–100.' };
        onProgress(`Setting volume to ${pct}%…`);
        await api.callService('media_player', 'volume_set', { entity_id: resourceId, volume_level: pct / 100 });
        return { ok: true, message: 'Volume updated.' };
      }
      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `Home Assistant operation ${operationId} on ${resourceId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = new HaApi(this.authFrom(ctx));
    const all = await api.states();
    return all
      .filter((s) => domainOf(s.entity_id) === kind)
      .sort((a, b) => this.nameOf(a).localeCompare(this.nameOf(b)))
      .map((s) => this.toResource(kind, s));
  }

  private nameOf(s: HaState): string {
    const fn = s.attributes?.friendly_name;
    return typeof fn === 'string' && fn ? fn : s.entity_id;
  }

  private toResource(kind: string, s: HaState): ConnectorResource {
    const a = s.attributes ?? {};
    const details: Record<string, string | number | boolean | null> = {};

    if (kind === 'sensor') {
      // Don't tack a unit onto a non-reading like "unavailable"/"unknown".
      details.value = a.unit_of_measurement && !DEAD_STATES.has(s.state) ? `${s.state} ${a.unit_of_measurement}` : s.state;
    }
    if (kind === 'climate') {
      if (a.current_temperature != null) details.current = `${a.current_temperature}°`;
      if (a.temperature != null) details.target = `${a.temperature}°`;
      if (a.hvac_action) details.action = String(a.hvac_action);
    }
    if (kind === 'light' && a.brightness != null) {
      details.brightness = `${Math.round((Number(a.brightness) / 255) * 100)}%`;
    }
    if (kind === 'media_player' && a.media_title) {
      details.playing = String(a.media_title);
    }

    const bat = batteryPct(s);
    if (bat != null) details.battery = `${bat}%`;
    if (a.device_class) details.class = String(a.device_class);
    details.changed = rel(s.last_changed);

    const tags: Record<string, string> = {};
    if (a.device_class) tags.class = String(a.device_class);

    return {
      id: s.entity_id,
      kind,
      name: this.nameOf(s),
      status: s.state,
      details,
      tags: Object.keys(tags).length ? tags : undefined,
    };
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = new HaApi(this.authFrom(ctx));
    const all = await api.states();
    const s = all.find((e) => e.entity_id === resourceId);
    if (!s) throw new Error(`Entity ${resourceId} not found.`);

    const general: ConnectorDetailItem[] = [
      { label: 'Entity ID', value: s.entity_id, variant: 'mono' },
      { label: 'State', value: s.state, variant: 'status' },
      { label: 'Last changed', value: rel(s.last_changed) ?? '—' },
      { label: 'Last updated', value: rel(s.last_updated) ?? '—' },
    ];

    const attrs: ConnectorDetailItem[] = Object.entries(s.attributes ?? {})
      .filter(([k]) => k !== 'friendly_name')
      .map(([k, v]) => ({
        label: k.replace(/_/g, ' '),
        value: Array.isArray(v) ? v.join(', ') : v == null ? '—' : String(v),
      }));

    const groups: ConnectorDetailGroup[] = [{ title: 'General', items: general }];
    if (attrs.length) groups.push({ title: 'Attributes', items: attrs });

    return { id: s.entity_id, kind, name: this.nameOf(s), status: s.state, groups };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = new HaApi(this.authFrom(ctx));
    const all = await api.states();

    // Only count entities that belong to a domain we surface, so the numbers line up
    // with what the user can actually browse in the tabs.
    const managed = all.filter((s) => KIND_IDS.has(domainOf(s.entity_id)));

    const unavailable = managed.filter((s) => DEAD_STATES.has(s.state)).length;
    const batteriesLow = all.filter((s) => {
      if (DEAD_STATES.has(s.state)) return false;
      const b = batteryPct(s);
      return b != null && b <= LOW_BATTERY_PCT;
    }).length;
    const updatesAvailable = all.filter((s) => domainOf(s.entity_id) === 'update' && s.state === 'on').length;
    const automationsOff = all.filter((s) => domainOf(s.entity_id) === 'automation' && s.state === 'off').length;

    const metrics = [
      { key: 'entitiesTotal', label: 'Entities', value: managed.length },
      { key: 'entitiesUnavailable', label: 'Unavailable', value: unavailable },
      { key: 'batteriesLow', label: 'Low batteries', value: batteriesLow },
      { key: 'updatesAvailable', label: 'Updates available', value: updatesAvailable },
      { key: 'automationsOff', label: 'Automations off', value: automationsOff },
    ];

    // Surface the problems first: unavailable entities, then a sample of the rest.
    const guests = managed
      .slice()
      .sort((a, b) => (DEAD_STATES.has(b.state) ? 1 : 0) - (DEAD_STATES.has(a.state) ? 1 : 0) || this.nameOf(a).localeCompare(this.nameOf(b)))
      .slice(0, 40)
      .map((s) => ({ name: this.nameOf(s), kind: domainOf(s.entity_id), status: s.state, node: '' }));

    return { metrics, guests };
  }
}

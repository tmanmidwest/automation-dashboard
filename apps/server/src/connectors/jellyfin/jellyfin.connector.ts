import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailItem,
  ConnectorOverview,
  OverviewMetric,
  TestConnectionResult,
} from '@cerebro/shared';
import { JellyfinApi, JellyfinAuth, JfSession, JfUser, JfVirtualFolder, JfScheduledTask, JfItemCounts } from './jellyfin-api';

const SESSION_KIND = 'session';
const USER_KIND = 'user';
const LIBRARY_KIND = 'library';
const TASK_KIND = 'task';

const TICKS_PER_SEC = 10_000_000;

/** Phase 1: read-only. Actions (pause/stop/scan/run) come in Phase 2. */
const KINDS: ConnectorResourceKind[] = [
  { id: SESSION_KIND, label: 'Now Playing', deletable: false, actions: [] },
  { id: USER_KIND, label: 'Users', deletable: false, actions: [] },
  { id: LIBRARY_KIND, label: 'Libraries', deletable: false, actions: [] },
  { id: TASK_KIND, label: 'Scheduled Tasks', deletable: false, actions: [] },
];

/**
 * Jellyfin media-server connector (read-only, Phase 1): active streams ("Now Playing"),
 * users, libraries, and scheduled tasks, plus overview tiles that flag transcodes.
 * See docs/connectors/jellyfin.md.
 */
export class JellyfinConnector implements Connector {
  manifest: ConnectorManifest = {
    id: 'jellyfin',
    name: 'Jellyfin',
    description:
      'Monitor a Jellyfin media server: who is streaming what right now (and who is transcoding), users, libraries, and scheduled tasks — with tiles that flag active streams and transcodes.',
    version: '0.1.0',
    icon: 'jellyfin',
    configFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'http://10.0.0.5:8096', help: 'Your Jellyfin server URL, including the port.' },
      { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'Dashboard → Administration → API Keys → New API Key.' },
      { key: 'insecureSkipVerify', label: 'Skip TLS verification (self-signed HTTPS)', type: 'boolean', required: false, default: false },
    ],
    resourceKinds: KINDS,
    help: {
      overview: 'Monitor Jellyfin: a "Now Playing" list of active streams (with play method and transcode flag), users and their last activity, libraries and item counts, and scheduled tasks. The summary flags active streams and transcodes.',
      setupSteps: [
        'In Jellyfin: Dashboard → Administration → API Keys → New API Key. Name it "Cerebro".',
        'Copy the key and paste it here, along with your server URL (e.g. http://10.0.0.5:8096).',
      ],
    },
  };

  private apiFrom(ctx: ConnectorContext): JellyfinApi {
    const auth: JellyfinAuth = {
      baseUrl: String(ctx.config.baseUrl ?? ''),
      apiKey: String(ctx.config.apiKey ?? ''),
      insecureSkipVerify: bool(ctx.config.insecureSkipVerify),
    };
    return new JellyfinApi(auth);
  }

  async testConnection(ctx: ConnectorContext): Promise<TestConnectionResult> {
    const api = this.apiFrom(ctx);
    try {
      const info = await api.systemInfo();
      const name = info.ServerName ?? 'Jellyfin';
      ctx.log('info', `Jellyfin reachable: ${name} (${info.Version ?? '?'}).`);
      return {
        ok: true,
        message: `Connected to ${name} — Jellyfin ${info.Version ?? '?'}.`,
        details: { server: name, version: info.Version ?? '?', os: info.OperatingSystem ?? '?' },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed.';
      ctx.log('warn', `Jellyfin connection test failed: ${message}`);
      return { ok: false, message };
    }
  }

  async listResources(ctx: ConnectorContext, kind: string): Promise<ConnectorResource[]> {
    const api = this.apiFrom(ctx);

    if (kind === SESSION_KIND) {
      const sessions = (await api.sessions()).filter((s) => s.NowPlayingItem);
      return sessions.map((s) => sessionToResource(s)).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (kind === USER_KIND) {
      const users = await api.users();
      return users.map((u) => userToResource(u)).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (kind === LIBRARY_KIND) {
      const folders = await api.virtualFolders();
      return folders.map((f) => libraryToResource(f)).sort((a, b) => a.name.localeCompare(b.name));
    }
    if (kind === TASK_KIND) {
      const tasks = await api.scheduledTasks();
      return tasks.map((t) => taskToResource(t)).sort((a, b) => a.name.localeCompare(b.name));
    }
    return [];
  }

  async describeResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<ConnectorResourceDetail> {
    const api = this.apiFrom(ctx);
    if (kind === SESSION_KIND) {
      const s = (await api.sessions()).find((x) => x.Id === resourceId);
      if (!s) return { id: resourceId, kind, name: 'Session ended', status: 'idle', groups: [] };
      const r = sessionToResource(s);
      const items: ConnectorDetailItem[] = Object.entries(r.details ?? {}).map(([k, v]) => ({ label: labelize(k), value: String(v ?? '—') }));
      return { id: resourceId, kind, name: r.name, status: r.status, groups: [{ title: 'Session', items }] };
    }
    // Generic detail for the other kinds.
    const list = await this.listResources(ctx, kind);
    const r = list.find((x) => x.id === resourceId);
    const items: ConnectorDetailItem[] = Object.entries(r?.details ?? {}).map(([k, v]) => ({ label: labelize(k), value: String(v ?? '—') }));
    return { id: resourceId, kind, name: r?.name ?? resourceId, status: r?.status, groups: [{ title: 'Details', items }] };
  }

  async performAction(): Promise<{ ok: boolean; message: string }> {
    // Read-only in Phase 1 — controls (pause/stop/message/scan/run) land in Phase 2.
    return { ok: false, message: 'This action is not available yet (read-only in this version).' };
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [sessions, users, counts] = await Promise.all([
      api.sessions().catch(() => [] as JfSession[]),
      api.users().catch(() => [] as JfUser[]),
      api.itemCounts().catch(() => ({}) as JfItemCounts),
    ]);
    const active = sessions.filter((s) => s.NowPlayingItem);
    const transcodes = active.filter((s) => s.TranscodingInfo).length;

    const metrics: OverviewMetric[] = [
      { key: 'activeStreams', label: 'Now playing', value: active.length },
      { key: 'transcodes', label: 'Transcoding', value: transcodes },
      { key: 'users', label: 'Users', value: users.length },
      { key: 'movies', label: 'Movies', value: num(counts.MovieCount) },
      { key: 'episodes', label: 'Episodes', value: num(counts.EpisodeCount) },
      { key: 'series', label: 'Series', value: num(counts.SeriesCount) },
    ];

    const guests = active
      .sort((a, b) => (a.UserName ?? '').localeCompare(b.UserName ?? ''))
      .slice(0, 40)
      .map((s) => ({
        name: `${s.UserName ?? '?'} · ${nowPlayingTitle(s)}`,
        kind: SESSION_KIND,
        status: s.PlayState?.IsPaused ? 'paused' : s.TranscodingInfo ? 'transcoding' : 'playing',
        node: s.DeviceName ?? s.Client ?? '',
      }));

    return { metrics, guests };
  }
}

// ── Mappers ───────────────────────────────────────────────────────

function sessionToResource(s: JfSession): ConnectorResource {
  const paused = !!s.PlayState?.IsPaused;
  const transcoding = !!s.TranscodingInfo;
  const status = paused ? 'paused' : transcoding ? 'transcoding' : 'playing';
  const pos = s.PlayState?.PositionTicks ?? 0;
  const total = s.NowPlayingItem?.RunTimeTicks ?? 0;
  const progress = total > 0 ? Math.min(100, Math.round((pos / total) * 100)) : 0;
  return {
    id: s.Id,
    kind: SESSION_KIND,
    name: `${s.UserName ?? '?'} · ${nowPlayingTitle(s)}`,
    status,
    details: {
      user: s.UserName ?? '—',
      item: nowPlayingTitle(s),
      type: s.NowPlayingItem?.Type ?? '—',
      client: s.Client ?? '—',
      device: s.DeviceName ?? '—',
      play_method: s.PlayState?.PlayMethod ?? (transcoding ? 'Transcode' : '—'),
      progress: `${progress}% (${fmtTicks(pos)} / ${fmtTicks(total)})`,
      ...(transcoding ? { transcode_bitrate: mbps(s.TranscodingInfo?.Bitrate), transcode_reason: (s.TranscodingInfo?.TranscodeReasons ?? []).join(', ') || '—' } : {}),
    },
    tags: { status, ...(transcoding ? { transcode: 'yes' } : {}) },
  };
}

function userToResource(u: JfUser): ConnectorResource {
  const disabled = !!u.Policy?.IsDisabled;
  const admin = !!u.Policy?.IsAdministrator;
  return {
    id: u.Id,
    kind: USER_KIND,
    name: u.Name ?? u.Id,
    status: disabled ? 'disabled' : admin ? 'admin' : 'enabled',
    details: {
      admin: admin ? 'Yes' : 'No',
      enabled: disabled ? 'No' : 'Yes',
      last_activity: rel(u.LastActivityDate),
      last_login: rel(u.LastLoginDate),
    },
    tags: { role: admin ? 'admin' : 'user', ...(disabled ? { state: 'disabled' } : {}) },
  };
}

function libraryToResource(f: JfVirtualFolder): ConnectorResource {
  return {
    id: f.ItemId || f.Name || 'library',
    kind: LIBRARY_KIND,
    name: f.Name ?? 'Library',
    status: f.CollectionType ?? 'mixed',
    details: {
      type: f.CollectionType ?? 'mixed',
      folders: String((f.Locations ?? []).length),
    },
    tags: { type: f.CollectionType ?? 'mixed' },
  };
}

function taskToResource(t: JfScheduledTask): ConnectorResource {
  const running = t.State === 'Running';
  const lastStatus = t.LastExecutionResult?.Status;
  const status = running ? 'running' : lastStatus === 'Failed' ? 'failed' : 'idle';
  return {
    id: t.Id,
    kind: TASK_KIND,
    name: t.Name ?? t.Id,
    status,
    details: {
      state: t.State ?? '—',
      ...(running ? { progress: `${Math.round(t.CurrentProgressPercentage ?? 0)}%` } : {}),
      last_result: lastStatus ?? '—',
      last_run: rel(t.LastExecutionResult?.EndTimeUtc),
      ...(t.LastExecutionResult?.ErrorMessage ? { error: t.LastExecutionResult.ErrorMessage } : {}),
    },
    tags: { state: (t.State ?? 'idle').toLowerCase() },
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function nowPlayingTitle(s: JfSession): string {
  const item = s.NowPlayingItem;
  if (!item) return 'idle';
  if (item.Type === 'Episode' && item.SeriesName) return `${item.SeriesName} — ${item.Name ?? ''}`.trim();
  return item.Name ?? 'Unknown';
}

function fmtTicks(ticks: number): string {
  const secs = Math.floor((ticks || 0) / TICKS_PER_SEC);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function mbps(bitrate?: number): string {
  if (!bitrate) return '—';
  return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
}

function rel(iso?: string): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function labelize(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === 1 || v === '1';
}

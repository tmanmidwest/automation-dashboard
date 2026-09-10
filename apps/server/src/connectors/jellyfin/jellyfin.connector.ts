import type {
  Connector,
  ConnectorContext,
  ConnectorManifest,
  ConnectorOperation,
  ConnectorFormField,
  ConnectorResource,
  ConnectorResourceDetail,
  ConnectorResourceKind,
  ConnectorDetailItem,
  ConnectorOverview,
  OverviewMetric,
  OperationProgress,
  OperationResult,
  TestConnectionResult,
} from '@cerebro/shared';
import { JellyfinApi, JellyfinAuth, JfSession, JfUser, JfVirtualFolder, JfScheduledTask, JfItemCounts, JfDevice, JfActivityEntry, JfPlugin, JfSystemInfo } from './jellyfin-api';

const SERVER_KIND = 'server';
const SESSION_KIND = 'session';
const USER_KIND = 'user';
const LIBRARY_KIND = 'library';
const TASK_KIND = 'task';
const DEVICE_KIND = 'device';
const ACTIVITY_KIND = 'activity';
const PLUGIN_KIND = 'plugin';

const TICKS_PER_SEC = 10_000_000;
/** Session statuses that mean something is actively playing (drive which controls show). */
const PLAYING_LIKE = ['playing', 'transcoding'];

const KINDS: ConnectorResourceKind[] = [
  {
    id: SERVER_KIND, label: 'Server', deletable: false,
    actions: [
      { id: 'scan-all', label: 'Scan all libraries', mutating: true },
      { id: 'restart', label: 'Restart', mutating: true, intent: 'destructive', confirm: 'Restart the Jellyfin server? Active streams will drop.' },
      { id: 'shutdown', label: 'Shut down', mutating: true, intent: 'destructive', confirm: 'Shut down the Jellyfin server? It will go offline until started again.' },
    ],
  },
  {
    id: SESSION_KIND, label: 'Now Playing', deletable: false,
    actions: [
      { id: 'pause', label: 'Pause', mutating: true, showWhenStatus: PLAYING_LIKE },
      { id: 'unpause', label: 'Resume', mutating: true, showWhenStatus: ['paused'] },
      { id: 'stop', label: 'Stop', mutating: true, intent: 'destructive', confirm: 'Stop this stream?', showWhenStatus: [...PLAYING_LIKE, 'paused'] },
    ],
  },
  {
    id: USER_KIND, label: 'Users', deletable: true,
    actions: [
      { id: 'disable', label: 'Disable', mutating: true, intent: 'destructive', confirm: 'Disable this user? They will not be able to sign in.', showWhenStatus: ['enabled', 'admin'] },
      { id: 'enable', label: 'Enable', mutating: true, showWhenStatus: ['disabled'] },
      { id: 'make-admin', label: 'Make admin', mutating: true, showWhenStatus: ['enabled'] },
      { id: 'revoke-admin', label: 'Revoke admin', mutating: true, intent: 'destructive', confirm: 'Remove administrator rights from this user?', showWhenStatus: ['admin'] },
      { id: 'remove-avatar', label: 'Remove avatar', mutating: true, intent: 'destructive', confirm: 'Remove this user\'s profile image?' },
    ],
  },
  { id: LIBRARY_KIND, label: 'Libraries', deletable: false, actions: [{ id: 'scan', label: 'Scan', mutating: true }] },
  { id: TASK_KIND, label: 'Scheduled Tasks', deletable: false, actions: [{ id: 'run', label: 'Run now', mutating: true, showWhenStatus: ['idle', 'failed'] }] },
  { id: DEVICE_KIND, label: 'Devices', deletable: true, actions: [] },
  { id: ACTIVITY_KIND, label: 'Activity', deletable: false, actions: [] },
  { id: PLUGIN_KIND, label: 'Plugins', deletable: false, actions: [] },
];

// ── Full user editor (Policy + Configuration) ─────────────────────
// One descriptor list drives the edit-user form, its prefill, and the save
// merge — so every field round-trips through the same key + target + coder.

type UserFieldTarget = 'policy' | 'config';
type UserFieldType = 'boolean' | 'number' | 'text' | 'select' | 'arrayCsv' | 'intOrNull' | 'folders';

interface UserFieldDef {
  /** Jellyfin property name inside Policy/Configuration (e.g. 'EnableMediaPlayback'). */
  key: string;
  label: string;
  target: UserFieldTarget;
  type: UserFieldType;
  help?: string;
  options?: { label: string; value: string }[];
  showWhen?: { field: string; equals: boolean };
}

const SUBTITLE_MODES = ['Default', 'Always', 'OnlyForced', 'None', 'Smart'];
const SYNCPLAY_MODES = ['CreateAndJoinGroups', 'JoinGroups', 'None'];

/** Every editable Policy + Configuration field the Jellyfin user page exposes. */
const USER_FIELD_DEFS: UserFieldDef[] = [
  // Policy — core status
  { key: 'IsAdministrator', label: 'Administrator', target: 'policy', type: 'boolean', help: 'Full server admin rights.' },
  { key: 'IsDisabled', label: 'Disabled (cannot sign in)', target: 'policy', type: 'boolean' },
  { key: 'IsHidden', label: 'Hidden from login screen', target: 'policy', type: 'boolean' },
  // Policy — playback permissions
  { key: 'EnableMediaPlayback', label: 'Allow media playback', target: 'policy', type: 'boolean' },
  { key: 'EnableAudioPlaybackTranscoding', label: 'Allow audio transcoding', target: 'policy', type: 'boolean' },
  { key: 'EnableVideoPlaybackTranscoding', label: 'Allow video transcoding', target: 'policy', type: 'boolean' },
  { key: 'EnablePlaybackRemuxing', label: 'Allow video remuxing', target: 'policy', type: 'boolean' },
  { key: 'ForceRemoteSourceTranscoding', label: 'Force transcoding of remote sources', target: 'policy', type: 'boolean' },
  // Policy — content management
  { key: 'EnableContentDeletion', label: 'Allow content deletion', target: 'policy', type: 'boolean' },
  { key: 'EnableContentDownloading', label: 'Allow media downloads', target: 'policy', type: 'boolean' },
  { key: 'EnableCollectionManagement', label: 'Allow collection management', target: 'policy', type: 'boolean' },
  { key: 'EnableSubtitleManagement', label: 'Allow subtitle management', target: 'policy', type: 'boolean' },
  { key: 'EnableSyncTranscoding', label: 'Allow sync transcoding (downloads)', target: 'policy', type: 'boolean' },
  { key: 'EnableMediaConversion', label: 'Allow media conversion', target: 'policy', type: 'boolean' },
  // Policy — remote / device control
  { key: 'EnableRemoteAccess', label: 'Allow remote (off-LAN) connections', target: 'policy', type: 'boolean' },
  { key: 'EnableRemoteControlOfOtherUsers', label: 'Allow remote control of other users', target: 'policy', type: 'boolean' },
  { key: 'EnableSharedDeviceControl', label: 'Allow control of shared devices', target: 'policy', type: 'boolean' },
  { key: 'EnableUserPreferenceAccess', label: 'Allow editing own display preferences', target: 'policy', type: 'boolean' },
  // Policy — live TV
  { key: 'EnableLiveTvAccess', label: 'Allow Live TV access', target: 'policy', type: 'boolean' },
  { key: 'EnableLiveTvManagement', label: 'Allow Live TV management', target: 'policy', type: 'boolean' },
  // Policy — library access
  { key: 'EnableAllFolders', label: 'Access all libraries', target: 'policy', type: 'boolean' },
  { key: 'EnabledFolders', label: 'Allowed libraries', target: 'policy', type: 'folders', help: 'Comma-separated library names.', showWhen: { field: 'EnableAllFolders', equals: false } },
  // Policy — device access
  { key: 'EnableAllDevices', label: 'Access from all devices', target: 'policy', type: 'boolean' },
  { key: 'EnabledDevices', label: 'Allowed device IDs', target: 'policy', type: 'arrayCsv', help: 'Comma-separated device IDs.', showWhen: { field: 'EnableAllDevices', equals: false } },
  // Policy — channel access
  { key: 'EnableAllChannels', label: 'Access all channels', target: 'policy', type: 'boolean' },
  { key: 'EnabledChannels', label: 'Allowed channel IDs', target: 'policy', type: 'arrayCsv', help: 'Comma-separated channel IDs.', showWhen: { field: 'EnableAllChannels', equals: false } },
  // Policy — parental control
  { key: 'MaxParentalRating', label: 'Max parental rating (score)', target: 'policy', type: 'intOrNull', help: 'Blank = no limit.' },
  { key: 'BlockUnratedItems', label: 'Block unrated item types', target: 'policy', type: 'arrayCsv', help: 'e.g. Movie, Series, Music, Book, LiveTvChannel, Other.' },
  { key: 'BlockedTags', label: 'Blocked tags', target: 'policy', type: 'arrayCsv', help: 'Comma-separated tags.' },
  { key: 'AllowedTags', label: 'Allowed tags (allowlist)', target: 'policy', type: 'arrayCsv', help: 'Comma-separated tags.' },
  // Policy — limits & sync
  { key: 'MaxActiveSessions', label: 'Max simultaneous streams', target: 'policy', type: 'number', help: '0 = unlimited.' },
  { key: 'RemoteClientBitrateLimit', label: 'Remote bitrate limit (bit/s)', target: 'policy', type: 'number', help: '0 = unlimited.' },
  { key: 'LoginAttemptsBeforeLockout', label: 'Failed logins before lockout', target: 'policy', type: 'number', help: '-1 = default, 0 = never lock.' },
  { key: 'SyncPlayAccess', label: 'SyncPlay access', target: 'policy', type: 'select', options: SYNCPLAY_MODES.map((v) => ({ label: v, value: v })) },
  { key: 'AuthenticationProviderId', label: 'Authentication provider', target: 'policy', type: 'text', help: 'Advanced — e.g. an LDAP provider id.' },
  { key: 'PasswordResetProviderId', label: 'Password reset provider', target: 'policy', type: 'text', help: 'Advanced.' },
  // Configuration — display / playback preferences
  { key: 'AudioLanguagePreference', label: 'Preferred audio language', target: 'config', type: 'text', help: 'ISO code, e.g. eng.' },
  { key: 'PlayDefaultAudioTrack', label: 'Play default audio track regardless of language', target: 'config', type: 'boolean' },
  { key: 'SubtitleLanguagePreference', label: 'Preferred subtitle language', target: 'config', type: 'text', help: 'ISO code, e.g. eng.' },
  { key: 'SubtitleMode', label: 'Subtitle mode', target: 'config', type: 'select', options: SUBTITLE_MODES.map((v) => ({ label: v, value: v })) },
  { key: 'DisplayMissingEpisodes', label: 'Display missing episodes', target: 'config', type: 'boolean' },
  { key: 'HidePlayedInLatest', label: 'Hide played items from "Latest"', target: 'config', type: 'boolean' },
  { key: 'RememberAudioSelections', label: 'Remember audio selections', target: 'config', type: 'boolean' },
  { key: 'RememberSubtitleSelections', label: 'Remember subtitle selections', target: 'config', type: 'boolean' },
  { key: 'EnableNextEpisodeAutoPlay', label: 'Auto-play next episode', target: 'config', type: 'boolean' },
  { key: 'EnableLocalPassword', label: 'Require a PIN on this network', target: 'config', type: 'boolean' },
  { key: 'CastReceiverId', label: 'Cast receiver id', target: 'config', type: 'text', help: 'Advanced.' },
  { key: 'GroupedFolders', label: 'Grouped into "My Media" as home', target: 'config', type: 'folders', help: 'Comma-separated library names.' },
  { key: 'LatestItemsExcludes', label: 'Exclude from "Latest"', target: 'config', type: 'folders', help: 'Comma-separated library names.' },
  { key: 'MyMediaExcludes', label: 'Exclude from "My Media"', target: 'config', type: 'folders', help: 'Comma-separated library names.' },
  { key: 'OrderedViews', label: 'Home screen library order', target: 'config', type: 'folders', help: 'Comma-separated library names, in order.' },
];

/** Build the operation form field for a user-field descriptor. */
function defToFormField(d: UserFieldDef): ConnectorFormField {
  const type: ConnectorFormField['type'] =
    d.type === 'boolean' ? 'boolean'
    : d.type === 'number' ? 'number'
    : d.type === 'select' ? 'select'
    : d.type === 'arrayCsv' || d.type === 'folders' ? 'textarea'
    : 'text'; // text + intOrNull
  return {
    key: d.key, label: d.label, type, required: false,
    ...(d.help ? { help: d.help } : {}),
    ...(d.options ? { options: d.options } : {}),
    ...(d.showWhen ? { showWhen: d.showWhen } : {}),
  };
}

const EDIT_USER_FIELDS: ConnectorFormField[] = [
  { key: 'name', label: 'Username', type: 'text', required: true },
  ...USER_FIELD_DEFS.map(defToFormField),
];

const OPERATIONS: ConnectorOperation[] = [
  {
    id: 'edit-user',
    label: 'Edit settings',
    description: 'Rename the user and edit the full Jellyfin access policy and display preferences.',
    scope: 'resource',
    kind: USER_KIND,
    icon: 'sliders-horizontal',
    submitLabel: 'Save settings',
    prefill: true,
    fields: EDIT_USER_FIELDS,
  },
  {
    id: 'create-user',
    label: 'New user',
    description: 'Create a Jellyfin user account.',
    scope: 'create',
    kind: USER_KIND,
    icon: 'user-plus',
    submitLabel: 'Create user',
    fields: [
      { key: 'name', label: 'Username', type: 'text', required: true, placeholder: 'jane' },
      { key: 'password', label: 'Password', type: 'password', required: false, help: 'Leave blank for no password (the user can set one on first login).' },
      { key: 'isAdmin', label: 'Administrator', type: 'boolean', required: false, default: false, help: 'Grant full admin rights.' },
    ],
  },
  {
    id: 'set-avatar',
    label: 'Set avatar',
    description: 'Upload a profile image for this user.',
    scope: 'resource',
    kind: USER_KIND,
    icon: 'image',
    submitLabel: 'Upload',
    fields: [
      { key: 'image', label: 'Avatar image', type: 'image', required: true, help: 'PNG or JPEG. Large images are downscaled automatically.' },
    ],
  },
  {
    id: 'reset-password',
    label: 'Set password',
    description: 'Set or clear this user\'s password.',
    scope: 'resource',
    kind: USER_KIND,
    icon: 'key-round',
    submitLabel: 'Save password',
    fields: [
      { key: 'password', label: 'New password', type: 'password', required: false, help: 'Leave blank to remove the password entirely.' },
    ],
  },
  {
    id: 'send-message',
    label: 'Send message',
    description: 'Pop a message on the client that owns this session.',
    scope: 'resource',
    kind: SESSION_KIND,
    icon: 'message-square',
    submitLabel: 'Send',
    fields: [
      { key: 'text', label: 'Message', type: 'text', required: true, placeholder: 'Please switch to Direct Play 🙂' },
      { key: 'header', label: 'Header', type: 'text', required: false, default: 'Cerebro' },
    ],
  },
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
      'Monitor and control a Jellyfin media server: who is streaming what (and who is transcoding), users, libraries, and scheduled tasks. Full user management — create/delete users, set passwords, upload avatars, and edit the complete access policy + display preferences (library/device access, parental controls, playback & content permissions, limits); pause/stop a stream, message a client, scan a library, run a task — with tiles + alerts for active streams, transcodes, and failed tasks.',
    version: '0.7.0',
    icon: 'jellyfin',
    live: true,
    configFields: [
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: true, placeholder: 'http://10.0.0.5:8096', help: 'Your Jellyfin server URL, including the port.' },
      { key: 'apiKey', label: 'API key', type: 'password', secret: true, required: true, help: 'Dashboard → Administration → API Keys → New API Key.' },
      { key: 'insecureSkipVerify', label: 'Skip TLS verification (self-signed HTTPS)', type: 'boolean', required: false, default: false },
    ],
    resourceKinds: KINDS,
    operations: OPERATIONS,
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

    if (kind === SERVER_KIND) {
      const info = await api.systemInfo();
      return [serverToResource(info)];
    }
    if (kind === DEVICE_KIND) {
      const devices = await api.devices();
      devices.sort((a, b) => Date.parse(b.DateLastActivity ?? '') - Date.parse(a.DateLastActivity ?? '') || 0);
      return devices.map((d) => deviceToResource(d));
    }
    if (kind === ACTIVITY_KIND) {
      const entries = await api.activity(40);
      return entries.map((e) => activityToResource(e));
    }
    if (kind === PLUGIN_KIND) {
      const plugins = await api.plugins();
      return plugins.map((p) => pluginToResource(p)).sort((a, b) => a.name.localeCompare(b.name));
    }
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

  async performAction(ctx: ConnectorContext, kind: string, resourceId: string, actionId: string): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFrom(ctx);
    try {
      if (kind === SERVER_KIND) {
        if (actionId === 'scan-all') {
          await api.refreshAllLibraries();
          return { ok: true, message: 'Library scan started for all libraries.' };
        }
        if (actionId === 'restart') {
          await api.restartServer();
          ctx.log('warn', 'Jellyfin server restart requested.');
          return { ok: true, message: 'Restart requested — the server will be briefly unavailable.' };
        }
        if (actionId === 'shutdown') {
          await api.shutdownServer();
          ctx.log('warn', 'Jellyfin server shutdown requested.');
          return { ok: true, message: 'Shutdown requested — the server is going offline.' };
        }
        return { ok: false, message: `Unsupported server action "${actionId}".` };
      }
      if (kind === SESSION_KIND) {
        const cmd = actionId === 'pause' ? 'Pause' : actionId === 'unpause' ? 'Unpause' : actionId === 'stop' ? 'Stop' : null;
        if (!cmd) return { ok: false, message: `Unsupported session action "${actionId}".` };
        await api.sessionCommand(resourceId, cmd);
        ctx.log('info', `Jellyfin session ${cmd} on ${resourceId.slice(0, 8)}.`);
        return { ok: true, message: `${cmd} sent to the client.` };
      }
      if (kind === USER_KIND && (actionId === 'enable' || actionId === 'disable')) {
        const disable = actionId === 'disable';
        const user = await api.getUser(resourceId);
        const policy = { ...(user.Policy ?? {}), IsDisabled: disable };
        await api.setUserPolicy(resourceId, policy);
        ctx.log('info', `Jellyfin user ${user.Name ?? resourceId} ${disable ? 'disabled' : 'enabled'}.`);
        return { ok: true, message: `User ${disable ? 'disabled' : 'enabled'}.` };
      }
      if (kind === USER_KIND && actionId === 'remove-avatar') {
        await api.deleteUserImage(resourceId);
        ctx.log('info', `Jellyfin user ${resourceId.slice(0, 8)} avatar removed.`);
        return { ok: true, message: 'Avatar removed.' };
      }
      if (kind === USER_KIND && (actionId === 'make-admin' || actionId === 'revoke-admin')) {
        const admin = actionId === 'make-admin';
        const user = await api.getUser(resourceId);
        const policy = { ...(user.Policy ?? {}), IsAdministrator: admin };
        await api.setUserPolicy(resourceId, policy);
        ctx.log('info', `Jellyfin user ${user.Name ?? resourceId} admin ${admin ? 'granted' : 'revoked'}.`);
        return { ok: true, message: `Administrator rights ${admin ? 'granted' : 'revoked'}.` };
      }
      if (kind === LIBRARY_KIND && actionId === 'scan') {
        await api.refreshItem(resourceId);
        return { ok: true, message: 'Library scan started.' };
      }
      if (kind === TASK_KIND && actionId === 'run') {
        await api.runTask(resourceId);
        return { ok: true, message: 'Task started.' };
      }
      return { ok: false, message: `Unsupported action "${actionId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Action failed.';
      ctx.log('error', `Jellyfin ${kind} ${actionId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async deleteResource(ctx: ConnectorContext, kind: string, resourceId: string): Promise<{ ok: boolean; message: string }> {
    const api = this.apiFrom(ctx);
    if (kind === USER_KIND) {
      try {
        const user = await api.getUser(resourceId).catch(() => null);
        await api.deleteUser(resourceId);
        ctx.log('info', `Jellyfin user ${user?.Name ?? resourceId} deleted.`);
        return { ok: true, message: 'User deleted.' };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed.';
        ctx.log('error', `Jellyfin user delete failed: ${message}`);
        return { ok: false, message };
      }
    }
    if (kind !== DEVICE_KIND) return { ok: false, message: `Cannot delete a ${kind}.` };
    try {
      await api.deleteDevice(resourceId);
      ctx.log('info', `Jellyfin device ${resourceId.slice(0, 8)} removed.`);
      return { ok: true, message: 'Device removed.' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Delete failed.';
      ctx.log('error', `Jellyfin device delete failed: ${message}`);
      return { ok: false, message };
    }
  }

  /** Prefill the edit-user form with the user's current policy + configuration. */
  async operationDefaults(ctx: ConnectorContext, operationId: string, resourceId: string | undefined): Promise<Record<string, unknown>> {
    if (operationId !== 'edit-user' || !resourceId) return {};
    const api = this.apiFrom(ctx);
    const user = await api.getUser(resourceId);
    const policy = user.Policy ?? {};
    const config = user.Configuration ?? {};
    const { idToName } = await folderMaps(api);
    const out: Record<string, unknown> = { name: user.Name ?? '' };
    for (const d of USER_FIELD_DEFS) {
      const raw = (d.target === 'policy' ? policy : config)[d.key];
      out[d.key] = formatUserField(d, raw, idToName);
    }
    return out;
  }

  async runOperation(ctx: ConnectorContext, operationId: string, resourceId: string | undefined, values: Record<string, unknown>, _onProgress: OperationProgress): Promise<OperationResult> {
    const api = this.apiFrom(ctx);
    try {
      if (operationId === 'edit-user') {
        if (!resourceId) return { ok: false, message: 'Missing user reference.' };
        const newName = String(values.name ?? '').trim();
        if (!newName) return { ok: false, message: 'A username is required.' };
        // Merge form values over the *fresh* policy/config so untouched settings
        // (e.g. access schedules, unknown future fields) are preserved verbatim.
        const user = await api.getUser(resourceId);
        const policy: Record<string, unknown> = { ...(user.Policy ?? {}) };
        const config: Record<string, unknown> = { ...(user.Configuration ?? {}) };
        const { nameToId } = await folderMaps(api);
        for (const d of USER_FIELD_DEFS) {
          if (!(d.key in values)) continue;
          const target = d.target === 'config' ? config : policy;
          target[d.key] = parseUserField(d, values[d.key], nameToId);
        }
        if (newName !== (user.Name ?? '')) await api.updateUser(resourceId, { ...user, Name: newName });
        await api.setUserPolicy(resourceId, policy);
        await api.setUserConfiguration(resourceId, config);
        ctx.log('info', `Jellyfin user ${newName} settings updated.`);
        return { ok: true, message: 'User settings saved.' };
      }
      if (operationId === 'create-user') {
        const name = String(values.name ?? '').trim();
        if (!name) return { ok: false, message: 'A username is required.' };
        const password = String(values.password ?? '');
        const created = await api.createUser(name, password || undefined);
        if (bool(values.isAdmin) && created.Id) {
          const policy = { ...(created.Policy ?? {}), IsAdministrator: true };
          await api.setUserPolicy(created.Id, policy);
        }
        ctx.log('info', `Jellyfin user ${name} created${bool(values.isAdmin) ? ' (admin)' : ''}.`);
        return { ok: true, message: `User "${name}" created.`, createdResourceId: created.Id };
      }
      if (operationId === 'set-avatar') {
        if (!resourceId) return { ok: false, message: 'Missing user reference.' };
        const parsed = parseDataUrl(String(values.image ?? ''));
        if (!parsed) return { ok: false, message: 'Please choose a valid image.' };
        await api.setUserImage(resourceId, parsed.contentType, parsed.base64);
        ctx.log('info', `Jellyfin user ${resourceId.slice(0, 8)} avatar set (${parsed.contentType}).`);
        return { ok: true, message: 'Avatar updated.' };
      }
      if (operationId === 'reset-password') {
        if (!resourceId) return { ok: false, message: 'Missing user reference.' };
        const password = String(values.password ?? '');
        await api.setUserPassword(resourceId, password || undefined);
        ctx.log('info', `Jellyfin user ${resourceId.slice(0, 8)} password ${password ? 'set' : 'cleared'}.`);
        return { ok: true, message: password ? 'Password updated.' : 'Password cleared.' };
      }
      if (operationId === 'send-message') {
        if (!resourceId) return { ok: false, message: 'Missing session reference.' };
        const text = String(values.text ?? '').trim();
        if (!text) return { ok: false, message: 'A message is required.' };
        await api.sendMessage(resourceId, text, String(values.header ?? 'Cerebro') || 'Cerebro');
        return { ok: true, message: 'Message sent.' };
      }
      return { ok: false, message: `Unknown operation "${operationId}".` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Operation failed.';
      ctx.log('error', `Jellyfin operation ${operationId} failed: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * Live "Now Playing" via Jellyfin's WebSocket. Pushes each active session as it
   * changes and emits a `removed` update when a stream ends. Auto-reconnects.
   */
  async subscribeLive(ctx: ConnectorContext, onUpdate: (resource: ConnectorResource) => void): Promise<() => void> {
    const api = this.apiFrom(ctx);
    const controller = new AbortController();
    let prevIds = new Set<string>();

    const run = () => {
      api
        .watchSessions((sessions) => {
          const active = sessions.filter((s) => s.NowPlayingItem);
          const nowIds = new Set(active.map((s) => s.Id));
          for (const s of active) onUpdate(sessionToResource(s));
          // A stream that vanished from the list has ended — tell the UI to drop it.
          for (const id of prevIds) {
            if (!nowIds.has(id)) onUpdate({ id, kind: SESSION_KIND, name: '', status: 'removed', details: {}, tags: {} });
          }
          prevIds = nowIds;
        }, controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return;
          ctx.log('debug', `Jellyfin live socket ended (${err instanceof Error ? err.message : err}); reconnecting in 5s.`);
          setTimeout(() => { if (!controller.signal.aborted) run(); }, 5000);
        });
    };
    run();
    ctx.log('info', 'Jellyfin live session stream subscribed.');
    return () => controller.abort();
  }

  async overview(ctx: ConnectorContext): Promise<ConnectorOverview> {
    const api = this.apiFrom(ctx);
    const [sessions, users, counts, tasks] = await Promise.all([
      api.sessions().catch(() => [] as JfSession[]),
      api.users().catch(() => [] as JfUser[]),
      api.itemCounts().catch(() => ({}) as JfItemCounts),
      api.scheduledTasks().catch(() => [] as JfScheduledTask[]),
    ]);
    const active = sessions.filter((s) => s.NowPlayingItem);
    const transcodes = active.filter((s) => s.TranscodingInfo).length;
    const tasksFailed = tasks.filter((t) => t.LastExecutionResult?.Status === 'Failed').length;

    const metrics: OverviewMetric[] = [
      { key: 'activeStreams', label: 'Now playing', value: active.length },
      { key: 'transcodes', label: 'Transcoding', value: transcodes },
      { key: 'users', label: 'Users', value: users.length },
      { key: 'movies', label: 'Movies', value: num(counts.MovieCount) },
      { key: 'episodes', label: 'Episodes', value: num(counts.EpisodeCount) },
      { key: 'series', label: 'Series', value: num(counts.SeriesCount) },
      { key: 'tasksFailed', label: 'Failed tasks', value: tasksFailed },
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

function serverToResource(info: JfSystemInfo): ConnectorResource {
  return {
    id: info.Id || 'server',
    kind: SERVER_KIND,
    name: info.ServerName ?? 'Jellyfin',
    status: 'online',
    details: {
      version: info.Version ?? '—',
      operating_system: info.OperatingSystem ?? '—',
      id: info.Id ?? '—',
    },
    tags: { version: info.Version ?? '?' },
  };
}

function deviceToResource(d: JfDevice): ConnectorResource {
  return {
    id: d.Id || d.Name || 'device',
    kind: DEVICE_KIND,
    name: `${d.LastUserName ?? '?'} · ${d.Name ?? d.AppName ?? 'Device'}`,
    status: 'known',
    details: {
      user: d.LastUserName ?? '—',
      device: d.Name ?? '—',
      app: [d.AppName, d.AppVersion].filter(Boolean).join(' ') || '—',
      last_activity: rel(d.DateLastActivity),
    },
    tags: { app: d.AppName ?? 'app' },
  };
}

function activityToResource(e: JfActivityEntry): ConnectorResource {
  const sev = (e.Severity ?? 'Information').toLowerCase();
  const status = sev === 'error' || sev === 'critical' ? 'error' : sev === 'warning' ? 'warning' : 'info';
  return {
    id: String(e.Id ?? `${e.Date}-${e.Name}`),
    kind: ACTIVITY_KIND,
    name: e.Name ?? 'Activity',
    status,
    details: {
      severity: e.Severity ?? 'Information',
      when: rel(e.Date),
      ...(e.ShortOverview ? { detail: e.ShortOverview } : {}),
    },
    tags: { severity: sev },
  };
}

function pluginToResource(p: JfPlugin): ConnectorResource {
  const status = (p.Status ?? 'active').toLowerCase() === 'active' ? 'active' : (p.Status ?? 'unknown').toLowerCase();
  return {
    id: p.Id || p.Name || 'plugin',
    kind: PLUGIN_KIND,
    name: p.Name ?? 'Plugin',
    status,
    details: {
      version: p.Version ?? '—',
      status: p.Status ?? '—',
      ...(p.Description ? { description: p.Description } : {}),
    },
    tags: { status },
  };
}

// ── Helpers ───────────────────────────────────────────────────────

/** Build id↔name maps for the server's libraries (for the folder-list fields). */
async function folderMaps(api: JellyfinApi): Promise<{ idToName: Map<string, string>; nameToId: Map<string, string> }> {
  const folders = await api.virtualFolders().catch(() => [] as JfVirtualFolder[]);
  const idToName = new Map<string, string>();
  const nameToId = new Map<string, string>();
  for (const f of folders) {
    if (f.ItemId && f.Name) {
      idToName.set(f.ItemId, f.Name);
      nameToId.set(f.Name.toLowerCase(), f.ItemId);
    }
  }
  return { idToName, nameToId };
}

/** Parse a `data:<mime>;base64,<data>` URL into its content type + base64 payload. */
function parseDataUrl(v: string): { contentType: string; base64: string } | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(v.trim());
  if (!m || !m[2]) return null; // must be base64-encoded
  const base64 = m[3];
  if (!base64) return null;
  return { contentType: m[1] || 'image/jpeg', base64 };
}

/** Split a comma/newline-separated field into trimmed, non-empty entries. */
function csvToArray(v: unknown): string[] {
  return String(v ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Current stored value → the form's field value. */
function formatUserField(d: UserFieldDef, raw: unknown, idToName: Map<string, string>): unknown {
  switch (d.type) {
    case 'boolean': return raw === true;
    case 'number': return typeof raw === 'number' ? raw : Number(raw ?? 0) || 0;
    case 'intOrNull': return raw == null ? '' : String(raw);
    case 'arrayCsv': return Array.isArray(raw) ? raw.map((x) => String(x)).join(', ') : '';
    case 'folders': return Array.isArray(raw) ? raw.map((id) => idToName.get(String(id)) ?? String(id)).join(', ') : '';
    default: return raw == null ? '' : String(raw); // text | select
  }
}

/** Form field value → the value written back into Policy/Configuration. */
function parseUserField(d: UserFieldDef, v: unknown, nameToId: Map<string, string>): unknown {
  switch (d.type) {
    case 'boolean': return v === true;
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : 0; }
    case 'intOrNull': { const t = String(v ?? '').trim(); if (!t) return null; const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; }
    case 'arrayCsv': return csvToArray(v);
    case 'folders': return csvToArray(v).map((entry) => nameToId.get(entry.toLowerCase()) ?? entry);
    default: return String(v ?? ''); // text | select
  }
}

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

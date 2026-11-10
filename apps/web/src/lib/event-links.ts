import type { TimelineEvent } from '@cerebro/shared';

/** A place in the app an event can be followed to. */
export interface EventLink {
  to: string;
  /** Short name of the destination, e.g. "Connector · UDM SE" or "Stack backups". */
  label: string;
}

/** Just enough of a connector instance to resolve an event to its page. */
export interface ConnectorRef {
  id?: string;
  name: string;
}

/** The event's own entry in the Ship's Log (detail + what was logged around it). */
export function eventLogLink(e: Pick<TimelineEvent, 'id'>): string {
  return `/timeline?event=${encodeURIComponent(e.id)}`;
}

// App-log contexts (the first argument to LoggingService.warn/error) → the page that owns
// that subsystem. `auth`, `notify:*` etc. that have no better home are handled below.
const LOG_CONTEXT_PAGES: Array<[prefix: string, link: EventLink]> = [
  ['stack-backup', { to: '/backups', label: 'Stack backups' }],
  ['stack-migrate', { to: '/migrate', label: 'Stack migration' }],
  ['replicator', { to: '/replicator', label: 'App Replicator' }],
  ['topology', { to: '/map', label: 'Architecture map' }],
  ['devices', { to: '/map', label: 'Architecture map' }],
  ['posture', { to: '/posture', label: 'Posture' }],
  ['npm:audit', { to: '/posture', label: 'Posture' }],
  ['health', { to: '/health', label: 'Health' }],
  ['fabric', { to: '/fabric', label: 'Fabric' }],
  ['notify:monitor', { to: '/monitors', label: 'Monitors' }],
  ['monitors', { to: '/monitors', label: 'Monitors' }],
  ['secrets', { to: '/settings/secrets', label: 'Secrets' }],
  ['system-backup', { to: '/settings/backup', label: 'Backup & restore' }],
  ['notify', { to: '/settings/notifications', label: 'Notification settings' }],
  ['mail', { to: '/settings/email', label: 'Email settings' }],
  ['docker-fleet', { to: '/docker-fleet', label: 'Docker fleet' }],
  ['assistant', { to: '/computer', label: 'Computer' }],
  ['mcp', { to: '/settings/mcp-servers', label: 'MCP servers' }],
];

// Alert keys (NotificationLog.alertKey) that aren't tied to one connector → their page.
const ALERT_PAGES: Array<[prefix: string, link: EventLink]> = [
  ['monitor.', { to: '/monitors', label: 'Monitors' }],
  ['fabric.', { to: '/fabric', label: 'Fabric' }],
  ['health.', { to: '/health', label: 'Health' }],
  ['backup.', { to: '/backups', label: 'Stack backups' }],
  ['restore.', { to: '/backups', label: 'Stack backups' }],
  ['secret.', { to: '/settings/secrets', label: 'Secrets' }],
  ['automation.', { to: '/automations', label: 'Automations' }],
  ['unifi.new_device', { to: '/map', label: 'New devices' }],
];

function connectorLink(id: string, connectors: ConnectorRef[]): EventLink {
  const name = connectors.find((c) => c.id === id)?.name;
  return { to: `/connectors/${id}`, label: name ? `Connector · ${name}` : 'Connector' };
}

/** A connector log line is written as `[<instance name>] message`; find that instance. */
function connectorByTitle(e: TimelineEvent, connectors: ConnectorRef[]): ConnectorRef | undefined {
  return connectors.find((c) => c.id && e.title.includes(`[${c.name}] `));
}

/**
 * Where the condition behind an event lives — the connector, monitor, backup, posture page…
 * Null when there's no page more specific than the log entry itself (e.g. an auth rejection:
 * the request came from outside, so the log entry and its context *are* the place to look).
 */
export function eventSourceLink(e: TimelineEvent, connectors: ConnectorRef[] = []): EventLink | null {
  const meta = e.meta ?? {};
  switch (e.kind) {
    case 'monitor':
      return e.source ? { to: `/monitors/${e.source}`, label: 'Monitor' } : { to: '/monitors', label: 'Monitors' };
    case 'job':
      if (e.id.startsWith('stackbackup:') || e.id.startsWith('stackrestore:')) return { to: '/backups', label: 'Stack backups' };
      return e.source ? connectorLink(e.source, connectors) : null;
    case 'notification': {
      const alertKey = typeof meta.alertKey === 'string' ? meta.alertKey : '';
      const page = ALERT_PAGES.find(([p]) => alertKey.startsWith(p));
      // New-device alerts are about the device, not the UniFi connector that spotted it.
      if (page && alertKey === 'unifi.new_device') return page[1];
      // Older rows have no meta.connectorId; their source is the connector id when one was set.
      const connectorId =
        typeof meta.connectorId === 'string'
          ? meta.connectorId
          : e.source && connectors.some((c) => c.id === e.source) ? e.source : null;
      if (connectorId) return connectorLink(connectorId, connectors);
      return page ? page[1] : null;
    }
    case 'audit':
      return typeof meta.connectorId === 'string' ? connectorLink(meta.connectorId, connectors) : null;
    case 'app_log': {
      const ctx = e.source ?? '';
      if (ctx.startsWith('connector:') || ctx === 'connectors') {
        const c = connectorByTitle(e, connectors);
        if (c?.id) return connectorLink(c.id, connectors);
        return { to: '/connectors', label: 'Connectors' };
      }
      const hit = LOG_CONTEXT_PAGES.find(([p]) => ctx === p || ctx.startsWith(`${p}:`));
      return hit ? hit[1] : null;
    }
    default:
      return null;
  }
}

/**
 * Settings pages worth checking for an event that has no single source page — today, auth
 * rejections: a bad bearer is either an API token, an OAuth client, or a disabled user.
 */
export function eventHintLinks(e: TimelineEvent): EventLink[] {
  if (e.kind === 'app_log' && e.source === 'auth') {
    const t = e.title.toLowerCase();
    const links: EventLink[] = [];
    if (t.includes('api token')) links.push({ to: '/settings/api-tokens', label: 'API tokens' });
    else if (t.includes('oauth') || t.includes('machine client') || t.includes('jwt')) links.push({ to: '/settings/oauth-clients', label: 'OAuth clients' });
    else if (t.includes('session')) links.push({ to: '/settings/users', label: 'Users' });
    else links.push({ to: '/settings/api-tokens', label: 'API tokens' }, { to: '/settings/oauth-clients', label: 'OAuth clients' });
    return links;
  }
  return [];
}

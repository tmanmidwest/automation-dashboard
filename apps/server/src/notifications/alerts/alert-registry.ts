import type { AlertTypeDef } from '@cerebro/shared';

/**
 * The alert catalog. Each entry is a kind of event the app can raise. Add a
 * type here when a new feature has something worth notifying about, then call
 * `NotificationsService.dispatchAlert(<key>, …)` from where it happens.
 *
 * Defaults (severity/enabled/channels) are the out-of-the-box behaviour; users
 * override them per type in the notifications settings (stored in Settings under
 * `notify.alert.<key>.*`).
 */
export const ALERT_TYPES: AlertTypeDef[] = [
  // ── Backups ──────────────────────────────────────────────
  {
    key: 'backup.failure',
    label: 'Backup failed',
    description: 'A scheduled or manual backup finished with an error.',
    category: 'Backups',
    defaultSeverity: 'critical',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'backup.success',
    label: 'Backup succeeded',
    description: 'A scheduled or manual backup completed successfully.',
    category: 'Backups',
    defaultSeverity: 'info',
    defaultEnabled: false,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'restore.failure',
    label: 'Restore failed',
    description: 'A restore from backup finished with an error.',
    category: 'Backups',
    defaultSeverity: 'critical',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'restore.success',
    label: 'Restore completed',
    description: 'A restore from backup completed successfully.',
    category: 'Backups',
    defaultSeverity: 'info',
    defaultEnabled: false,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'retention.failure',
    label: 'Retention prune failed',
    description: 'Applying backup retention (pruning old snapshots) failed.',
    category: 'Backups',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Connections ──────────────────────────────────────────
  {
    key: 'connection.down',
    label: 'Connector unreachable',
    description: 'A connector failed its connection check (was previously reachable).',
    category: 'Connections',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'connection.recovered',
    label: 'Connector recovered',
    description: 'A previously-unreachable connector is responding again.',
    category: 'Connections',
    defaultSeverity: 'info',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Resources ────────────────────────────────────────────
  {
    key: 'resource.stopped',
    label: 'Resource stopped',
    description: 'A VM, container, or instance changed to a stopped state.',
    category: 'Resources',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'resource.started',
    label: 'Resource started',
    description: 'A VM, container, or instance changed to a running state.',
    category: 'Resources',
    defaultSeverity: 'info',
    defaultEnabled: false,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Cost ─────────────────────────────────────────────────
  {
    key: 'cost.threshold',
    label: 'Monthly cost over threshold',
    description: "A connector's month-to-date spend crossed the limit set on its page.",
    category: 'Cost',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Storage ──────────────────────────────────────────────
  {
    key: 'storage.threshold',
    label: 'Storage over threshold',
    description: "A connector's storage size crossed the limit set on its page.",
    category: 'Storage',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Home Assistant ───────────────────────────────────────
  {
    key: 'ha.unavailable',
    label: 'Unavailable entities over threshold',
    description: "The number of unavailable/unknown Home Assistant entities crossed the limit set on its page.",
    category: 'Home Assistant',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'ha.batteries_low',
    label: 'Low batteries over threshold',
    description: "The number of low-battery Home Assistant entities crossed the limit set on its page.",
    category: 'Home Assistant',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'ha.updates',
    label: 'Updates available over threshold',
    description: "The number of available Home Assistant updates crossed the limit set on its page.",
    category: 'Home Assistant',
    defaultSeverity: 'info',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'ha.automations_off',
    label: 'Automations off over threshold',
    description: "The number of disabled Home Assistant automations crossed the limit set on its page.",
    category: 'Home Assistant',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  {
    key: 'ha.integrations',
    label: 'Degraded integrations over threshold',
    description: "The number of Home Assistant integrations that failed to set up crossed the limit set on its page.",
    category: 'Home Assistant',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: true,
  },
  // ── Monitors ─────────────────────────────────────────────
  {
    key: 'monitor.down',
    label: 'Monitor down',
    description: 'An uptime monitor failed its checks (after retries) and is now down.',
    category: 'Monitors',
    defaultSeverity: 'critical',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: false,
    monitorScoped: true,
  },
  {
    key: 'monitor.up',
    label: 'Monitor recovered',
    description: 'A previously-down uptime monitor is passing again.',
    category: 'Monitors',
    defaultSeverity: 'info',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: false,
    monitorScoped: true,
  },
  {
    key: 'monitor.cert_expiring',
    label: 'Certificate expiring',
    description: "An HTTPS monitor's TLS certificate expires within its warning window.",
    category: 'Monitors',
    defaultSeverity: 'warning',
    defaultEnabled: true,
    defaultChannels: ['email'],
    connectorScoped: false,
    monitorScoped: true,
  },
];

export function getAlertType(key: string): AlertTypeDef | undefined {
  return ALERT_TYPES.find((t) => t.key === key);
}

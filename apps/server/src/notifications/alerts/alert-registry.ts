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
];

export function getAlertType(key: string): AlertTypeDef | undefined {
  return ALERT_TYPES.find((t) => t.key === key);
}

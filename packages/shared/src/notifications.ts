/**
 * Outbound alerts / notifications.
 *
 * A notification is produced somewhere in the app (a failed backup, a lost
 * connection, later: a resource state change) and handed to the dispatcher,
 * which fans it out to every enabled channel that meets its severity bar.
 * Channels are the delivery mechanism (email, SMS via Textbelt, Signal).
 */

export type NotificationSeverity = 'info' | 'warning' | 'critical';

/** Ordered least → most urgent; index doubles as the comparison rank. */
export const NOTIFICATION_SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'critical'];

/** Higher = more urgent. Used for min-severity gating per channel. */
export function severityRank(s: NotificationSeverity): number {
  return NOTIFICATION_SEVERITIES.indexOf(s);
}

export type NotificationChannelId = 'email' | 'textbelt' | 'signal';

export interface NotificationMessage {
  /** Short one-line headline (becomes the email subject / SMS lead). */
  title: string;
  /** Longer detail. Plain text; channels format as appropriate. */
  body: string;
  /** Defaults to 'info' when omitted. */
  severity?: NotificationSeverity;
  /** Origin tag, e.g. 'backup', 'connection', 'monitor'. */
  source?: string;
  /**
   * Stable key for rate-limiting: repeated messages with the same dedupeKey
   * within the throttle window are suppressed. Defaults to the title.
   */
  dedupeKey?: string;
}

/**
 * A kind of alert the app can raise (backup failed, connector unreachable, …).
 * Types are defined in code; users override enabled/severity/channels per type.
 */
export interface AlertTypeDef {
  /** Stable id, e.g. 'backup.failure'. */
  key: string;
  label: string;
  description: string;
  /** Grouping label for the UI, e.g. 'Backups'. */
  category: string;
  defaultSeverity: NotificationSeverity;
  defaultEnabled: boolean;
  /** Channels this alert routes to out of the box. */
  defaultChannels: NotificationChannelId[];
  /**
   * True if this alert originates from a specific connector, so it can be muted
   * per connector (on the connector's detail page). System-wide alerts are false.
   */
  connectorScoped: boolean;
}

/** Per-type user configuration (overrides the type's defaults). */
export interface AlertRule {
  enabled: boolean;
  severity: NotificationSeverity;
  /** Which channels this alert is delivered to (the routing matrix row). */
  channels: NotificationChannelId[];
}

/** An alert type merged with its current (possibly overridden) rule — for the UI. */
export type AlertView = AlertTypeDef & AlertRule;

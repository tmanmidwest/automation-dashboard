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

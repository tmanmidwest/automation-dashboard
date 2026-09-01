import type { NotificationChannelId, NotificationMessage } from '@cerebro/shared';

/**
 * A delivery mechanism for notifications. Each channel owns its own transport
 * and formatting. Recipients are resolved by the dispatcher and passed in.
 */
export interface NotificationChannel {
  readonly id: NotificationChannelId;
  /** Deliver to every recipient. Throws on hard failure (the dispatcher logs it). */
  send(msg: NotificationMessage, recipients: string[]): Promise<void>;
}

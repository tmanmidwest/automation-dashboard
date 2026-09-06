import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SecretsService } from './secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LoggingService } from '../logging/logging.service';

/**
 * Daily rotation reminder. Walks the vault and raises a 'secret.rotation_due' (or
 * 'secret.expired') alert for any secret whose policy has lapsed. Lives apart
 * from SecretsService so the vault core never depends on notifications (which
 * depend on settings, which delegate to the vault). See docs/secrets-vault.md.
 */
@Injectable()
export class SecretsRotationService {
  constructor(
    private readonly secrets: SecretsService,
    private readonly notifications: NotificationsService,
    private readonly logging: LoggingService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async tick(): Promise<void> {
    let due;
    try {
      due = await this.secrets.dueForRotation();
    } catch (err) {
      await this.logging.error('secrets', `Rotation check failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
    for (const s of due) {
      const expired = s.health === 'expired';
      const parts = [
        expired ? 'has expired' : 'is due for rotation',
        s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleDateString()}` : null,
        s.rotateAfterDays != null ? `last rotated ${s.ageDays}d ago (policy ${s.rotateAfterDays}d)` : null,
      ].filter(Boolean);
      await this.notifications.dispatchAlert(expired ? 'secret.expired' : 'secret.rotation_due', {
        title: `Secret ${expired ? 'expired' : 'rotation due'}: ${s.label}`,
        body: `The ${s.category} secret "${s.label}" ${parts.join(' — ')}.`,
        dedupeKey: `${expired ? 'secret.expired' : 'secret.rotation_due'}:${s.key}`,
      });
    }
  }
}

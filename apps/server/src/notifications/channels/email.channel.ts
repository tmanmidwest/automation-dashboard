import { Injectable } from '@nestjs/common';
import type { NotificationChannelId, NotificationMessage } from '@cerebro/shared';
import { MailService } from '../../mail/mail.service';
import { NotificationChannel } from './notification-channel';

const SEVERITY_COLOR: Record<string, string> = {
  info: '#38bdf8',
  warning: '#f59e0b',
  critical: '#ef4444',
};

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

/** Email channel — reuses the existing SMTP MailService. */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly id: NotificationChannelId = 'email';

  constructor(private readonly mail: MailService) {}

  async send(msg: NotificationMessage, recipients: string[]): Promise<void> {
    const sev = msg.severity ?? 'info';
    const color = SEVERITY_COLOR[sev] ?? SEVERITY_COLOR.info;
    const tag = `${sev}${msg.source ? ` · ${msg.source}` : ''}`;
    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px">
        <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${color}">${escapeHtml(tag)}</p>
        <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(msg.title)}</h2>
        <p style="white-space:pre-wrap;line-height:1.5;margin:0">${escapeHtml(msg.body)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0"/>
        <p style="font-size:12px;color:#6b7280;margin:0">Sent by Cerebro 🧠</p>
      </div>`;
    await this.mail.send(
      recipients.join(', '),
      `[Cerebro · ${sev}] ${msg.title}`,
      html,
      `${msg.title}\n\n${msg.body}`,
    );
  }
}

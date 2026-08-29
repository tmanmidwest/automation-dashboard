import { BadRequestException, Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (465)
  username: string;
  fromAddress: string;
  fromName: string;
}

@Injectable()
export class MailService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  async getConfig(): Promise<SmtpConfig> {
    return {
      host: (await this.settings.get<string>('smtp.host')) ?? '',
      port: (await this.settings.get<number>('smtp.port')) ?? 587,
      secure: (await this.settings.get<boolean>('smtp.secure')) ?? false,
      username: (await this.settings.get<string>('smtp.username')) ?? '',
      fromAddress: (await this.settings.get<string>('smtp.fromAddress')) ?? '',
      fromName: (await this.settings.get<string>('smtp.fromName')) ?? 'Cerebro',
    };
  }

  async saveConfig(cfg: SmtpConfig & { password?: string }): Promise<void> {
    await this.settings.set('smtp.host', cfg.host.trim());
    await this.settings.set('smtp.port', cfg.port);
    await this.settings.set('smtp.secure', cfg.secure);
    await this.settings.set('smtp.username', cfg.username.trim());
    await this.settings.set('smtp.fromAddress', cfg.fromAddress.trim());
    await this.settings.set('smtp.fromName', cfg.fromName.trim() || 'Cerebro');
    if (cfg.password) {
      await this.settings.setSecret('smtp.password', cfg.password);
    }
  }

  async passwordSet(): Promise<boolean> {
    return this.settings.hasSecret('smtp.password');
  }

  private async transport() {
    const cfg = await this.getConfig();
    if (!cfg.host) throw new BadRequestException('SMTP host is not configured.');
    const password = (await this.settings.getSecret('smtp.password')) ?? undefined;
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.username ? { user: cfg.username, pass: password } : undefined,
    });
  }

  async send(to: string, subject: string, html: string, text?: string): Promise<void> {
    const cfg = await this.getConfig();
    const transport = await this.transport();
    const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress;
    await transport.sendMail({ from, to, subject, html, text });
    await this.logging.info('mail', `Sent "${subject}" to ${to}`);
  }

  async sendTest(to: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.send(
        to,
        'Cerebro test email',
        '<h2>It works! 🧠</h2><p>Your Cerebro outbound email is configured correctly.</p>',
        'It works! Your Cerebro outbound email is configured correctly.',
      );
      return { ok: true, message: `Test email sent to ${to}.` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await this.logging.error('mail', `Test email failed: ${message}`);
      return { ok: false, message };
    }
  }
}

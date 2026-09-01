import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SettingsService } from '../../settings/settings.service';
import { LoggingService } from '../../logging/logging.service';
import { SignalCli, SignalError } from './signal-cli';

export interface SignalStatus {
  /** signal-cli binary present in the image. */
  available: boolean;
  /** At least one account is registered/linked. */
  linked: boolean;
  /** The account Cerebro sends AS (E.164), or null. */
  account: string | null;
  /** All accounts known to signal-cli. */
  accounts: string[];
}

interface LinkSession {
  id: string;
  uri?: string;
  status: 'waiting' | 'linked' | 'error';
  account?: string;
  error?: string;
  startedAt: number;
}

/**
 * Manages the Signal *account lifecycle* — device linking and number
 * registration — which is the only involved part of the Signal integration.
 * Sending lives in SignalChannel. All state is held by signal-cli on its
 * config volume; we only cache the "send-as" account in Settings.
 */
@Injectable()
export class SignalService {
  private readonly cli = new SignalCli();
  /** In-flight link sessions, polled by the UI. In-memory; pruned after 30 min. */
  private readonly links = new Map<string, LinkSession>();

  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
  ) {}

  async status(): Promise<SignalStatus> {
    const available = await this.cli.isAvailable();
    const accounts = available ? await this.cli.listAccounts() : [];
    const saved = (await this.settings.get<string>('notify.signal.account')) || null;
    const account = saved && accounts.includes(saved) ? saved : (accounts[0] ?? saved);
    return { available, linked: accounts.length > 0, account, accounts };
  }

  /** Begin device-linking. Returns a session id and (usually) the QR URI. */
  async startLink(deviceName: string): Promise<{ id: string; uri?: string }> {
    const before = await this.cli.listAccounts().catch(() => [] as string[]);
    const id = randomUUID();
    const session: LinkSession = { id, status: 'waiting', startedAt: Date.now() };
    this.links.set(id, session);
    this.prune();

    // The link call blocks until the phone confirms — run it in the background
    // and capture the URI as signal-cli emits it.
    void this.cli
      .link(deviceName || 'Cerebro', (uri) => {
        session.uri = uri;
      })
      .then(async () => {
        const after = await this.cli.listAccounts().catch(() => [] as string[]);
        const account = after.find((a) => !before.includes(a)) ?? after[0];
        if (account) await this.settings.set('notify.signal.account', account);
        session.account = account;
        session.status = 'linked';
        await this.logging.info('notify:signal', `Linked device as ${account ?? 'unknown account'}`);
      })
      .catch(async (err) => {
        session.status = 'error';
        session.error = err instanceof Error ? err.message : 'Linking failed.';
        await this.logging.error('notify:signal', `Link failed: ${session.error}`);
      });

    // Give signal-cli a moment to print the URI so the first poll usually has it.
    await new Promise((r) => setTimeout(r, 800));
    return { id, uri: session.uri };
  }

  linkStatus(id: string): LinkSession | undefined {
    return this.links.get(id);
  }

  async register(
    number: string,
    captcha?: string,
    voice = false,
  ): Promise<{ ok: boolean; captchaRequired?: boolean; message: string }> {
    try {
      await this.cli.register(number, { captcha, voice });
      return { ok: true, message: `Verification code sent to ${number}. Enter it below to finish.` };
    } catch (err) {
      if (err instanceof SignalError && err.code === 'captcha') {
        return {
          ok: false,
          captchaRequired: true,
          message:
            'Signal requires a captcha. Open https://signalcaptchas.org/registration/generate.html, solve it, and paste the resulting token here.',
        };
      }
      return { ok: false, message: err instanceof Error ? err.message : 'Registration failed.' };
    }
  }

  async verify(number: string, code: string, pin?: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.cli.verify(number, code, pin);
      await this.settings.set('notify.signal.account', number);
      await this.logging.info('notify:signal', `Registered account ${number}`);
      return { ok: true, message: `${number} is registered and ready.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Verification failed.' };
    }
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, s] of this.links) {
      if (s.startedAt < cutoff && s.status !== 'waiting') this.links.delete(id);
    }
  }
}

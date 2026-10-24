import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { LocalLoginPolicy } from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../logging/audit.service';
import { LOCAL_LOGIN_SETTING_KEY, coercePolicy, isIpAllowed, normalizeCidrs, normalizeIp } from './local-login-policy';

/** Blocked attempts from one IP are audited at most once per window (a spray can't flood the log). */
const BLOCKED_AUDIT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Enforces who may use email + password sign-in (see docs/local-login-policy.md).
 * Read from the Setting table on every check — sign-ins are rare and this keeps a
 * break-glass change made by the CLI effective immediately, with no cache to bust.
 */
@Injectable()
export class LocalLoginPolicyService {
  private readonly log = new Logger('LocalLoginPolicy');
  private readonly lastBlockedAudit = new Map<string, number>();

  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<LocalLoginPolicy> {
    return coercePolicy(await this.settings.get(LOCAL_LOGIN_SETTING_KEY));
  }

  async set(input: LocalLoginPolicy): Promise<LocalLoginPolicy> {
    const policy: LocalLoginPolicy = { enabled: input.enabled, allowedCidrs: normalizeCidrs(input.allowedCidrs) };
    await this.settings.set(LOCAL_LOGIN_SETTING_KEY, policy);
    return policy;
  }

  async isAllowed(ip: string | undefined): Promise<boolean> {
    return isIpAllowed(await this.get(), ip);
  }

  /** Throw 403 when `ip` may not use password sign-in. Audits (throttled) the refusal. */
  async assertAllowed(ip: string | undefined, attemptedEmail?: string): Promise<void> {
    if (await this.isAllowed(ip)) return;
    const key = normalizeIp(ip) ?? 'unknown';
    const now = Date.now();
    if ((this.lastBlockedAudit.get(key) ?? 0) + BLOCKED_AUDIT_WINDOW_MS < now) {
      this.lastBlockedAudit.set(key, now);
      if (this.lastBlockedAudit.size > 1000) this.lastBlockedAudit.clear();
      this.log.warn(`password sign-in refused for ${key}`);
      await this.audit.record({
        actorEmail: attemptedEmail ?? null,
        action: 'auth.login_blocked_ip',
        target: key,
      });
    }
    throw new ForbiddenException('Password sign-in is not available from your network. Use single sign-on.');
  }
}

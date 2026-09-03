import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../logging/audit.service';

const ISSUER = 'Cerebro';
const RECOVERY_CODE_COUNT = 10;
/** Unambiguous alphabet for recovery codes (no 0/O/1/I/L). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Native TOTP (RFC 6238) second factor for local accounts. The shared secret is
 * encrypted at rest via {@link CryptoService}; enrollment is only *enforced* once
 * `totpEnabledAt` is set (see SessionAuthGuard / AuthController login gate).
 *
 * Recovery codes are single-use, bcrypt-hashed, and the sole lockout escape hatch
 * for a user who loses their authenticator (an admin reset is the other).
 */
@Injectable()
export class TotpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {
    // Tolerate one 30s step of clock drift either side.
    authenticator.options = { window: 1 };
  }

  /** Enrollment state for the account-settings UI. */
  async getStatus(userId: string): Promise<{ enabled: boolean; pending: boolean }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    return {
      enabled: !!user.totpEnabledAt,
      pending: !!user.totpSecret && !user.totpEnabledAt,
    };
  }

  /**
   * Generate a fresh secret, store it encrypted (still disabled), and return the
   * otpauth URL + a QR data-URL for the authenticator app. Re-callable while
   * pending; refuses once TOTP is already enabled.
   */
  async beginEnrollment(userId: string): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    if (!user.passwordHash) {
      throw new BadRequestException('This account signs in via SSO and cannot use a password-based second factor.');
    }
    if (user.totpEnabledAt) {
      throw new BadRequestException('Two-factor authentication is already enabled. Disable it first to re-enroll.');
    }

    const secret = authenticator.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: this.crypto.encrypt(secret), totpEnabledAt: null },
    });

    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { otpauthUrl, qrDataUrl };
  }

  /**
   * Verify the first code against the pending secret, then flip TOTP on and issue
   * a fresh set of recovery codes (returned in plaintext exactly once).
   */
  async confirmEnrollment(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    if (user.totpEnabledAt) throw new BadRequestException('Two-factor authentication is already enabled.');
    if (!user.totpSecret) throw new BadRequestException('Start setup before confirming a code.');

    if (!this.verifyTotp(user.totpSecret, code)) {
      throw new BadRequestException('That code is incorrect. Check your authenticator app and try again.');
    }

    const recoveryCodes = await this.issueRecoveryCodes(userId);
    await this.prisma.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });
    await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_enrolled' });
    return { recoveryCodes };
  }

  /**
   * Verify a second factor during login: accepts a live TOTP code or an unconsumed
   * recovery code (consumed on use). Returns true on success. Audits either way.
   */
  async verifyForLogin(userId: string, code: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpEnabledAt || !user.totpSecret) return false;

    if (this.verifyTotp(user.totpSecret, code)) {
      await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_verified' });
      return true;
    }
    if (await this.consumeRecoveryCode(userId, code)) {
      await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_recovery_used' });
      return true;
    }

    await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_failed' });
    return false;
  }

  /** Turn TOTP off (step-up: requires a current code). Clears secret + recovery codes. */
  async disable(userId: string, code: string): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    if (!user.totpEnabledAt || !user.totpSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled.');
    }
    if (!this.verifyTotp(user.totpSecret, code) && !(await this.consumeRecoveryCode(userId, code))) {
      throw new BadRequestException('That code is incorrect.');
    }

    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null } });
    await this.prisma.userRecoveryCode.deleteMany({ where: { userId } });
    await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_disabled' });
    return { ok: true };
  }

  /** Replace the recovery-code set (step-up: requires a current TOTP code). */
  async regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    if (!user.totpEnabledAt || !user.totpSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled.');
    }
    if (!this.verifyTotp(user.totpSecret, code)) {
      throw new BadRequestException('That code is incorrect.');
    }

    const recoveryCodes = await this.issueRecoveryCodes(userId);
    await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'auth.mfa_recovery_regenerated' });
    return { recoveryCodes };
  }

  // ── internals ────────────────────────────────────────────────

  private verifyTotp(encryptedSecret: string, code: string): boolean {
    const token = (code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(token)) return false;
    try {
      return authenticator.verify({ token, secret: this.crypto.decrypt(encryptedSecret) });
    } catch {
      return false;
    }
  }

  /** bcrypt-compare a candidate against unconsumed codes; mark the match consumed. */
  private async consumeRecoveryCode(userId: string, candidate: string): Promise<boolean> {
    const normalized = (candidate ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 8) return false;
    const codes = await this.prisma.userRecoveryCode.findMany({ where: { userId, consumedAt: null } });
    for (const row of codes) {
      if (await bcrypt.compare(normalized, row.codeHash)) {
        await this.prisma.userRecoveryCode.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
        return true;
      }
    }
    return false;
  }

  /** Wipe any existing codes and mint a fresh set; returns the plaintext codes once. */
  private async issueRecoveryCodes(userId: string): Promise<string[]> {
    await this.prisma.userRecoveryCode.deleteMany({ where: { userId } });
    const plaintext: string[] = [];
    const rows: { userId: string; codeHash: string }[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = this.randomRecoveryCode();
      plaintext.push(code);
      rows.push({ userId, codeHash: await bcrypt.hash(code, 12) });
    }
    await this.prisma.userRecoveryCode.createMany({ data: rows });
    return plaintext;
  }

  /** A 10-char code shown grouped as `XXXXX-XXXXX`; stored/compared without the dash. */
  private randomRecoveryCode(): string {
    const bytes = randomBytes(10);
    let out = '';
    for (let i = 0; i < 10; i++) out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    return `${out.slice(0, 5)}-${out.slice(5)}`;
  }
}

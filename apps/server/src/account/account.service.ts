import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { AuditService } from '../logging/audit.service';

function maskEmail(e: string): string {
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, u.length - 2))}@${d}`;
}

/**
 * Self-service password change for local accounts, gated by a one-time code
 * emailed to the user. Codes are held in memory, single-use, expiring, and
 * rate-limited by attempts.
 */
@Injectable()
export class AccountService {
  private readonly codes = new Map<string, { code: string; expiresAt: number; attempts: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  async requestPasswordChange(userId: string): Promise<{ ok: true; email: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    if (!user.passwordHash) {
      throw new BadRequestException('This account signs in via SSO and has no password to change.');
    }

    const code = String(randomInt(100000, 1000000));
    this.codes.set(userId, { code, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    try {
      await this.mail.send(
        user.email,
        'Cerebro password change code',
        `<h2>Password change</h2><p>Your verification code is <b style="font-size:22px;letter-spacing:2px">${code}</b></p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
        `Your Cerebro password change verification code is ${code}. It expires in 10 minutes.`,
      );
    } catch (err) {
      this.codes.delete(userId);
      const msg = err instanceof Error ? err.message : 'SMTP error';
      throw new BadRequestException(`Couldn't send the verification email (${msg}). Configure outbound email in Settings → Email.`);
    }

    await this.audit.record({ actorId: userId, actorEmail: user.email, action: 'account.password_change_requested' });
    return { ok: true, email: maskEmail(user.email) };
  }

  async confirmPasswordChange(userId: string, code: string, newPassword: string): Promise<{ ok: true }> {
    const entry = this.codes.get(userId);
    if (!entry) throw new BadRequestException('Request a verification code first.');
    if (Date.now() > entry.expiresAt) {
      this.codes.delete(userId);
      throw new BadRequestException('The code expired. Request a new one.');
    }
    if (entry.attempts >= 5) {
      this.codes.delete(userId);
      throw new BadRequestException('Too many attempts. Request a new code.');
    }
    if (code !== entry.code) {
      entry.attempts++;
      throw new BadRequestException('Incorrect code.');
    }
    if (!newPassword || newPassword.length < 10) {
      throw new BadRequestException('New password must be at least 10 characters.');
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    this.codes.delete(userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    await this.audit.record({ actorId: userId, actorEmail: user?.email, action: 'account.password_changed' });
    return { ok: true };
  }
}

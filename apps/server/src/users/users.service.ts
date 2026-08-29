import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const users = await this.prisma.user.findMany({
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      authProvider: u.authProvider,
      roleSlug: u.role.slug,
      roleName: u.role.name,
      disabled: u.disabled,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    }));
  }

  async listRoles() {
    return this.prisma.role.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * Create a user. With a password → a local account. Without → an SSO-only "invite":
   * no password (no local-login backdoor), authorized to sign in via a configured SSO
   * provider using this email. Anyone not created here can't get in when auto-create is off.
   */
  async create(input: { email: string; displayName?: string; password?: string; roleSlug: string }) {
    const role = await this.prisma.role.findUnique({ where: { slug: input.roleSlug } });
    if (!role) throw new BadRequestException('Unknown role.');
    const email = input.email.toLowerCase();
    const password = input.password?.trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new BadRequestException(
        password
          ? 'A user with that email already exists.'
          : `${email} already has an account — it will be linked to SSO automatically the first time they sign in with that provider, so no invite is needed.`,
      );
    }

    if (password && password.length < 10) throw new BadRequestException('Password must be at least 10 characters.');

    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const displayName = input.displayName?.trim() || email.split('@')[0];
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName,
        passwordHash,
        // SSO-only invites are marked 'oidc' so they show as such and can't local-login.
        authProvider: password ? 'local' : 'oidc',
        roleId: role.id,
      },
    });
    return { id: user.id, invited: !password };
  }

  async setRole(userId: string, roleSlug: string) {
    const role = await this.prisma.role.findUnique({ where: { slug: roleSlug } });
    if (!role) throw new BadRequestException('Unknown role.');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    await this.prisma.user.update({ where: { id: userId }, data: { roleId: role.id } });
    return { ok: true };
  }

  async setDisabled(userId: string, disabled: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    await this.prisma.user.update({ where: { id: userId }, data: { disabled } });
    return { ok: true };
  }

  /** Permanently delete a user. Cascades their linked SSO identities (revoking access). */
  async remove(userId: string, actingUserId: string) {
    if (userId === actingUserId) throw new BadRequestException("You can't delete your own account.");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    await this.prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { BUILTIN_ROLES } from '@cerebro/shared';
import type { Permission, SessionUser } from '@cerebro/shared';
import { SetupDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** True until the first (admin) user exists. */
  async isFirstRun(): Promise<boolean> {
    const count = await this.prisma.user.count();
    return count === 0;
  }

  /** Verify email + password for a local account. Returns the user id or null. */
  async validateLocal(email: string, password: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.disabled || !user.passwordHash) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return user.id;
  }

  /** Load a full SessionUser (role + permissions) for a session. */
  async buildSessionUser(userId: string): Promise<SessionUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { role: true },
    });
    if (!user || user.disabled) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      roleSlug: user.role.slug,
      roleName: user.role.name,
      permissions: user.role.permissions as Permission[],
      authProvider: user.authProvider === 'oidc' ? 'oidc' : 'local',
    };
  }

  /** First-run: create the initial administrator. Refuses if any user already exists. */
  async createInitialAdmin(dto: SetupDto): Promise<string> {
    if (!(await this.isFirstRun())) {
      throw new BadRequestException('Setup has already been completed.');
    }
    const adminRole = await this.ensureAdminRole();
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        displayName: dto.displayName,
        passwordHash,
        authProvider: 'local',
        roleId: adminRole.id,
      },
    });
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'setup.admin_created',
      target: user.email,
    });
    return user.id;
  }

  private async ensureAdminRole() {
    const slug = BUILTIN_ROLES.admin.slug;
    return this.prisma.role.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        name: BUILTIN_ROLES.admin.name,
        description: BUILTIN_ROLES.admin.description,
        permissions: BUILTIN_ROLES.admin.permissions,
        builtin: true,
      },
    });
  }
}

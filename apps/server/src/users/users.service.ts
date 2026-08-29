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

  async createLocal(input: { email: string; displayName: string; password: string; roleSlug: string }) {
    const role = await this.prisma.role.findUnique({ where: { slug: input.roleSlug } });
    if (!role) throw new BadRequestException('Unknown role.');
    const existing = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (existing) throw new BadRequestException('A user with that email already exists.');
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        passwordHash,
        authProvider: 'local',
        roleId: role.id,
      },
    });
    return { id: user.id };
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
}

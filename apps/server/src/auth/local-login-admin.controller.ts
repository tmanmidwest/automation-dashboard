import { BadRequestException, Body, Controller, Get, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsString } from 'class-validator';
import type { LocalLoginPolicy, LocalLoginPolicyView, SessionUser } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../logging/audit.service';
import { CurrentUser, RequirePermissions, SessionOnly } from './decorators';
import { LocalLoginPolicyService } from './local-login-policy.service';
import { BREAK_GLASS_COMMAND, isIpAllowed, normalizeCidrs, normalizeIp } from './local-login-policy';

class LocalLoginPolicyDto implements LocalLoginPolicy {
  @IsBoolean() enabled!: boolean;
  @IsArray() @IsString({ each: true }) allowedCidrs!: string[];
}

/** Settings → Authentication: who may use email + password sign-in. */
@Controller('api/settings/auth/local-login')
export class LocalLoginAdminController {
  constructor(
    private readonly policy: LocalLoginPolicyService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('settings:read')
  async get(@Req() req: Request): Promise<LocalLoginPolicyView> {
    return this.view(await this.policy.get(), req);
  }

  @Put()
  @SessionOnly()
  @RequirePermissions('settings:write')
  async update(
    @Body() dto: LocalLoginPolicyDto,
    @Req() req: Request,
    @CurrentUser() user: SessionUser,
  ): Promise<LocalLoginPolicyView> {
    let allowedCidrs: string[];
    try {
      allowedCidrs = normalizeCidrs(dto.allowedCidrs);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const next: LocalLoginPolicy = { enabled: dto.enabled, allowedCidrs };

    // Lockout guard: if this change shuts the caller out of password sign-in, they must
    // still have a working way back in — a linked identity on an enabled SSO provider.
    if (!isIpAllowed(next, req.ip) && !(await this.hasEnabledSso(user.id))) {
      throw new BadRequestException(
        'This would block password sign-in from your current address and you have no enabled single sign-on ' +
          'identity to fall back on. Link an SSO provider to your account first, or include your network in the list.',
      );
    }

    const before = await this.policy.get();
    const saved = await this.policy.set(next);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'settings.local_login_changed',
      meta: { before, after: saved, ip: normalizeIp(req.ip) },
    });
    return this.view(saved, req);
  }

  private async hasEnabledSso(userId: string): Promise<boolean> {
    const n = await this.prisma.userIdentity.count({ where: { userId, provider: { enabled: true } } });
    return n > 0;
  }

  private view(p: LocalLoginPolicy, req: Request): LocalLoginPolicyView {
    return {
      ...p,
      yourIp: normalizeIp(req.ip),
      yourIpAllowed: isIpAllowed(p, req.ip),
      breakGlassCommand: BREAK_GLASS_COMMAND,
    };
  }
}

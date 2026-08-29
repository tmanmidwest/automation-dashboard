import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) displayName!: string;
  @IsString() @MinLength(10) password!: string;
  @IsString() roleSlug!: string;
}
class SetRoleDto {
  @IsString() roleSlug!: string;
}
class SetDisabledDto {
  @IsBoolean() disabled!: boolean;
}

@Controller('api')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  @Get('users')
  @RequirePermissions('users:read')
  list() {
    return this.users.list();
  }

  @Get('roles')
  @RequirePermissions('users:read')
  roles() {
    return this.users.listRoles();
  }

  @Post('users')
  @RequirePermissions('users:write')
  async create(@Body() dto: CreateUserDto, @CurrentUser() actor: SessionUser) {
    const res = await this.users.createLocal(dto);
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'users.created',
      target: dto.email,
      meta: { roleSlug: dto.roleSlug },
    });
    return res;
  }

  @Patch('users/:id/role')
  @RequirePermissions('users:write')
  async setRole(@Param('id') id: string, @Body() dto: SetRoleDto, @CurrentUser() actor: SessionUser) {
    const res = await this.users.setRole(id, dto.roleSlug);
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'users.role_changed',
      target: id,
      meta: { roleSlug: dto.roleSlug },
    });
    return res;
  }

  @Patch('users/:id/disabled')
  @RequirePermissions('users:write')
  async setDisabled(@Param('id') id: string, @Body() dto: SetDisabledDto, @CurrentUser() actor: SessionUser) {
    const res = await this.users.setDisabled(id, dto.disabled);
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: dto.disabled ? 'users.disabled' : 'users.enabled',
      target: id,
    });
    return res;
  }
}

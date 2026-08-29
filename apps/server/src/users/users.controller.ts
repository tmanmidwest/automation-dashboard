import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { AuditService } from '../logging/audit.service';
import { RequirePermissions, CurrentUser } from '../auth/decorators';
import type { SessionUser } from '@cerebro/shared';

class CreateUserDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MinLength(2) displayName?: string;
  // Omit for an SSO-only invite (no password, no local login); include for a local account.
  @IsOptional() @IsString() @MinLength(10) password?: string;
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
    const res = await this.users.create(dto);
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: res.invited ? 'users.invited' : 'users.created',
      target: dto.email,
      meta: { roleSlug: dto.roleSlug, invited: res.invited },
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

  @Delete('users/:id')
  @RequirePermissions('users:write')
  async remove(@Param('id') id: string, @CurrentUser() actor: SessionUser) {
    const res = await this.users.remove(id, actor.id);
    await this.audit.record({ actorId: actor.id, actorEmail: actor.email, action: 'users.deleted', target: id });
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

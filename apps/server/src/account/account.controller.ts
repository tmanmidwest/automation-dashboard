import { Body, Controller, Post } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import type { SessionUser } from '@cerebro/shared';
import { CurrentUser } from '../auth/decorators';
import { AccountService } from './account.service';

class ConfirmDto {
  @IsString() code!: string;
  @IsString() @MinLength(10) newPassword!: string;
}

// No @RequirePermissions — any authenticated user may manage their OWN password.
@Controller('api/account')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Post('password/request')
  request(@CurrentUser() user: SessionUser) {
    return this.account.requestPasswordChange(user.id);
  }

  @Post('password/confirm')
  confirm(@Body() dto: ConfirmDto, @CurrentUser() user: SessionUser) {
    return this.account.confirmPasswordChange(user.id, dto.code, dto.newPassword);
  }
}

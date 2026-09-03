import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Module({
  imports: [MailModule, AuthModule], // AuthModule exports TotpService for the MFA endpoints
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}

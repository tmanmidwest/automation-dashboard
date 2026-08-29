import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Module({
  imports: [MailModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}

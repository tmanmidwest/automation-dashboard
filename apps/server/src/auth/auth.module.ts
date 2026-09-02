import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TokenAuthService } from './token-auth.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenAuthService],
  exports: [AuthService, TokenAuthService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TokensService } from './tokens.service';
import { TokensController } from './tokens.controller';

@Module({
  imports: [AuthModule], // for TokenAuthService (token generation)
  controllers: [TokensController],
  providers: [TokensService],
})
export class TokensModule {}

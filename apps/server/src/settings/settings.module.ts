import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { ViewscreenController } from './viewscreen.controller';

@Module({
  controllers: [ViewscreenController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}

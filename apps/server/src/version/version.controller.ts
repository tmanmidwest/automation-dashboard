import { Controller, Get } from '@nestjs/common';
import type { VersionInfo } from '@cerebro/shared';
import { Public } from '../auth/decorators';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version: string };

@Controller('api')
export class VersionController {
  private readonly startedAt = new Date().toISOString();

  @Get('version')
  version(): VersionInfo {
    return {
      version: pkg.version,
      gitSha: process.env.GIT_SHA ?? 'dev',
      builtAt: this.startedAt,
    };
  }

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}

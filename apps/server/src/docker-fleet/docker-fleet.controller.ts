import { Controller, Get, Query } from '@nestjs/common';
import { DockerFleetService } from './docker-fleet.service';
import { RequirePermissions } from '../auth/decorators';

/**
 * Read-only aggregate for the Docker Fleet screen. Control (start/stop/recreate,
 * redeploy/rollback/drift, shell/logs) reuses the normal
 * /api/connectors/instances/:id/… endpoints, keyed by each item's instanceId.
 */
@Controller('api/docker')
export class DockerFleetController {
  constructor(private readonly fleet: DockerFleetService) {}

  @Get('fleet')
  @RequirePermissions('connectors:read')
  get(@Query('force') force?: string) {
    return this.fleet.fleet(force === '1' || force === 'true');
  }
}

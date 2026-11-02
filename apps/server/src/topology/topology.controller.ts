import { Controller, Get, Query } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators';
import { TopologyService } from './topology.service';

/** Read-only architecture map. `?refresh=1` re-reads every source live instead of the cache. */
@Controller('api/topology')
export class TopologyController {
  constructor(private readonly topology: TopologyService) {}

  @Get()
  @RequirePermissions('connectors:read')
  get(@Query('refresh') refresh?: string) {
    return this.topology.graph(refresh === '1' || refresh === 'true');
  }
}

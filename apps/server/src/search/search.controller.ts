import { Controller, Get, Query } from '@nestjs/common';
import type { SearchHit } from '@cerebro/shared';
import { SearchService } from './search.service';
import { RequirePermissions } from '../auth/decorators';

/** Cross-connector resource search for the command palette (Phase 2). */
@Controller('api/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermissions('connectors:read')
  query(@Query('q') q?: string, @Query('limit') limit?: string): Promise<SearchHit[]> {
    const n = limit ? Math.min(50, Math.max(1, parseInt(limit, 10) || 20)) : 20;
    return this.search.search((q ?? '').trim(), n);
  }
}

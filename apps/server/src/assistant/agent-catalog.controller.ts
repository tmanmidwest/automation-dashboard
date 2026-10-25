import { BadRequestException, Controller, Get, HttpException, HttpStatus, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AgentCatalogEntry, AgentCatalogResponse, SessionUser } from '@cerebro/shared';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { RateLimiter } from '../common/rate-limiter';
import { AgentCatalogService, isCatalogStatus, type CatalogQuery } from './agent-catalog.service';

/** Catalog requests per caller (machine client, API token or user) per minute. */
const CATALOG_RATE = new RateLimiter(60, 60_000);

/**
 * External, read-only agent catalog for inventories such as Saviynt: discover every Computer
 * agent with its owners, labels, status, model and tools in one call. Needs `agents:read`
 * (an API token scope, or a machine OAuth client via client_credentials). There are no
 * write routes here. Every call is audited and rate limited per caller.
 */
@Controller('api/v1/agents')
@RequirePermissions('agents:read')
export class AgentCatalogController {
  constructor(
    private readonly catalog: AgentCatalogService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query() query: Record<string, string | undefined>,
  ): Promise<AgentCatalogResponse> {
    this.throttle(req, res);
    const q = parseQuery(query);
    const result = await this.catalog.list(q);
    await this.record(user, req, 'agents.catalog_listed', null, {
      returned: result.items.length,
      totalCount: result.totalCount,
      filters: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)),
    });
    return result;
  }

  @Get(':id')
  async get(
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
  ): Promise<AgentCatalogEntry> {
    this.throttle(req, res);
    const entry = await this.catalog.get(id);
    await this.record(user, req, 'agents.catalog_read', id, { name: entry.name });
    return entry;
  }

  private throttle(req: Request, res: Response) {
    const key = req.oauthClientId ? `client:${req.oauthClientId}` : req.apiTokenId ? `token:${req.apiTokenId}` : `user:${req.user?.id}`;
    const retryAfter = CATALOG_RATE.hit(key);
    if (retryAfter !== null) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Too many requests to the agent catalog.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private record(user: SessionUser, req: Request, action: string, target: string | null, meta: Record<string, unknown>) {
    return this.audit
      .record({
        actorId: user.id,
        actorEmail: req.oauthClientId && user.id.startsWith('oauth-client:') ? null : user.email,
        action,
        target,
        meta: { ...meta, via: req.principalType, oauthClientId: req.oauthClientId, tokenId: req.apiTokenId, ip: req.ip },
      })
      .catch(() => undefined);
  }
}

function parseQuery(query: Record<string, string | undefined>): CatalogQuery {
  const q: CatalogQuery = {};
  if (query.updatedSince) {
    const d = new Date(query.updatedSince);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('updatedSince must be an ISO 8601 date-time.');
    q.updatedSince = d;
  }
  if (query.status) {
    if (!isCatalogStatus(query.status)) throw new BadRequestException('status must be ready, disabled or not_configured.');
    q.status = query.status;
  }
  if (query.environment) q.environment = query.environment;
  if (query.label) {
    const i = query.label.indexOf(':');
    if (i <= 0) throw new BadRequestException('label must be key:value.');
    q.label = { key: query.label.slice(0, i).toLowerCase(), value: query.label.slice(i + 1).toLowerCase() };
  }
  if (query.page !== undefined || query.limit !== undefined) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 100);
    if (!Number.isInteger(page) || page < 1) throw new BadRequestException('page must be 1 or more.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BadRequestException('limit must be between 1 and 1000.');
    q.page = page;
    q.limit = limit;
  }
  return q;
}

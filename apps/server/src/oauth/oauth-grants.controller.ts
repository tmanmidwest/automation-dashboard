import { Controller, Delete, Get, Param } from '@nestjs/common';
import type { OAuthGrantSummary, SessionUser } from '@cerebro/shared';
import { CurrentUser, SessionOnly } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { OAuthFlowService } from './oauth-flow.service';

/**
 * Self-service management of the current user's own OAuth authorizations ("connected apps").
 * Session-only: only the person who granted access can view or revoke it.
 */
@SessionOnly()
@Controller('api/oauth/grants')
export class OAuthGrantsController {
  constructor(
    private readonly flow: OAuthFlowService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() user: SessionUser): Promise<OAuthGrantSummary[]> {
    return this.flow.listUserGrants(user.id);
  }

  @Delete(':clientId')
  async revoke(@Param('clientId') clientId: string, @CurrentUser() user: SessionUser): Promise<{ ok: true }> {
    await this.flow.revokeUserGrant(user.id, clientId);
    await this.audit.record({
      actorId: user.id,
      actorEmail: user.email,
      action: 'oauth.grant_revoked',
      target: clientId,
    });
    return { ok: true };
  }
}

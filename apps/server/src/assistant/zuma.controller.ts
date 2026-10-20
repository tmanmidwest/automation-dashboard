import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import type { AssistantAgentView, SessionUser, ZumaConnectionInput, ZumaConnectionView } from '@cerebro/shared';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { AssistantAgentsService } from './assistant-agents.service';
import { ZumaService } from './zuma.service';

/**
 * Saviynt Zuma agent registry: the tenant connection, and registering / syncing agents.
 * Needs `agents:manage`. Session-only.
 */
@Controller('api/assistant/zuma')
@SessionOnly()
@RequirePermissions('agents:manage')
export class ZumaController {
  constructor(
    private readonly zuma: ZumaService,
    private readonly agents: AssistantAgentsService,
    private readonly audit: AuditService,
  ) {}

  @Get('connection')
  connection(): Promise<ZumaConnectionView> {
    return this.zuma.getConnection();
  }

  @Put('connection')
  async setConnection(
    @CurrentUser() user: SessionUser,
    @Body() body: Partial<ZumaConnectionInput> & { credential?: string },
  ): Promise<ZumaConnectionView> {
    const { credential, ...patch } = body ?? {};
    const view = await this.zuma.setConnection(patch, credential, { actorId: user.id, actorEmail: user.email });
    await this.record(user, 'assistant.zuma.connection_updated', 'zuma', {
      baseUrl: view.baseUrl,
      tenantId: view.tenantId,
      authMode: view.authMode,
      enabled: view.enabled,
      credentialChanged: credential !== undefined,
    });
    return view;
  }

  @Post('connection/test')
  test(): Promise<{ ok: true; agentCount: number | null }> {
    return this.zuma.testConnection();
  }

  /** Register the agent with Zuma, or push its current details if it already is. */
  @Post('agents/:id/sync')
  async sync(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<AssistantAgentView> {
    const before = await this.agents.get(id);
    const row = await this.zuma.sync(before);
    await this.record(user, before.zumaAgentId ? 'assistant.zuma.agent_synced' : 'assistant.zuma.agent_registered', id, {
      name: row.name,
      zumaAgentId: row.zumaAgentId,
    });
    return this.agents.view(row);
  }

  @Post('agents/:id/status')
  async status(@Param('id') id: string): Promise<AssistantAgentView> {
    return this.agents.view(await this.zuma.refreshStatus(await this.agents.get(id)));
  }

  /** Forget the registration here. The agent stays in Zuma; retire it there. */
  @Delete('agents/:id')
  async unlink(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<AssistantAgentView> {
    const before = await this.agents.get(id);
    const row = await this.zuma.unlink(before);
    await this.record(user, 'assistant.zuma.agent_unlinked', id, { name: row.name, zumaAgentId: before.zumaAgentId });
    return this.agents.view(row);
  }

  private record(user: SessionUser, action: string, target: string, meta: Record<string, unknown>) {
    return this.audit
      .record({ actorId: user.id, actorEmail: user.email, action, target, meta })
      .catch(() => undefined);
  }
}

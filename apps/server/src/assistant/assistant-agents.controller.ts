import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import {
  BUILTIN_ROLES,
  type AssistantAgentInput,
  type AssistantAgentSummary,
  type AssistantAgentView,
  type AssistantModelInfo,
  type AssistantToolInfo,
  type SessionUser,
} from '@cerebro/shared';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { AssistantAgentsService } from './assistant-agents.service';

/** Synthetic principal holding every permission, used only to enumerate the tool catalog. */
const CATALOG_PROBE_USER: SessionUser = {
  id: 'system:catalog',
  email: 'catalog@cerebro.local',
  displayName: 'Catalog',
  roleSlug: 'system',
  roleName: 'System',
  permissions: [...BUILTIN_ROLES.admin.permissions],
  authProvider: 'local',
};

/**
 * Computer agent profiles. Listing the agents you may chat with needs `assistant:use`;
 * everything else (create/edit/delete, the tool picker, model lists) needs
 * `agents:manage`. Session-only, like the rest of the assistant.
 */
@Controller('api/assistant')
@SessionOnly()
export class AssistantAgentsController {
  constructor(
    private readonly agents: AssistantAgentsService,
    private readonly catalog: ToolCatalogService,
    private readonly audit: AuditService,
  ) {}

  /** Agents the caller may chat with (for the chat page's agent picker). */
  @Get('agents')
  @RequirePermissions('assistant:use')
  list(@CurrentUser() user: SessionUser): Promise<AssistantAgentSummary[]> {
    return this.agents.listFor(user);
  }

  /** Every agent with its full configuration (for the agent editor). */
  @Get('agents/manage')
  @RequirePermissions('agents:manage')
  listAll(): Promise<AssistantAgentView[]> {
    return this.agents.list();
  }

  /** Every built-in tool, for the editor's tool picker. Chat still filters by the user's RBAC. */
  @Get('tools')
  @RequirePermissions('agents:manage')
  tools(): AssistantToolInfo[] {
    return this.catalog.build(CATALOG_PROBE_USER).map((t) => ({
      name: t.name,
      description: t.description,
      kind: t.kind,
      permission: t.permission,
      destructive: !!t.destructive,
    }));
  }

  @Get('agents/:id')
  @RequirePermissions('agents:manage')
  get(@Param('id') id: string): Promise<AssistantAgentView> {
    return this.agents.getView(id);
  }

  @Post('agents')
  @RequirePermissions('agents:manage')
  async create(
    @CurrentUser() user: SessionUser,
    @Body() body: AssistantAgentInput & { apiKey?: string },
  ): Promise<AssistantAgentView> {
    const { apiKey, ...input } = body ?? ({} as AssistantAgentInput);
    const view = await this.agents.create(input, apiKey || undefined);
    await this.record(user, 'assistant.agent.created', view);
    return view;
  }

  @Put('agents/:id')
  @RequirePermissions('agents:manage')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: Partial<AssistantAgentInput> & { apiKey?: string },
  ): Promise<AssistantAgentView> {
    const { apiKey, ...patch } = body ?? {};
    const view = await this.agents.update(id, patch, apiKey);
    await this.record(user, 'assistant.agent.updated', view, { apiKeyChanged: apiKey !== undefined });
    return view;
  }

  @Delete('agents/:id')
  @RequirePermissions('agents:manage')
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<{ ok: true }> {
    const view = await this.agents.getView(id);
    await this.agents.remove(id);
    await this.record(user, 'assistant.agent.deleted', view);
    return { ok: true };
  }

  /** Models the agent's backend advertises (save the URL/key first). */
  @Get('agents/:id/models')
  @RequirePermissions('agents:manage')
  async models(@Param('id') id: string): Promise<AssistantModelInfo[]> {
    return this.agents.listModels(await this.agents.get(id));
  }

  private record(user: SessionUser, action: string, view: AssistantAgentView, extra: Record<string, unknown> = {}) {
    return this.audit
      .record({
        actorId: user.id,
        actorEmail: user.email,
        action,
        target: view.id,
        meta: { name: view.name, backend: view.backend, model: view.model, toolMode: view.toolMode, ...extra },
      })
      .catch(() => undefined);
  }
}

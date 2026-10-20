import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import type { McpServerInput, McpServerView, SessionUser } from '@cerebro/shared';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { AuditService } from '../logging/audit.service';
import { McpServersService } from './mcp-servers.service';

const actor = (u: SessionUser) => ({ actorId: u.id, actorEmail: u.email });

/**
 * External MCP servers the Computer's agents can use as tools. Managing them (and pinning
 * their tool list with /refresh) needs `agents:manage`. Session-only.
 */
@Controller('api/assistant/mcp-servers')
@SessionOnly()
@RequirePermissions('agents:manage')
export class McpServersController {
  constructor(
    private readonly servers: McpServersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): Promise<McpServerView[]> {
    return this.servers.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<McpServerView> {
    return this.servers.getView(id);
  }

  @Post()
  async create(
    @CurrentUser() user: SessionUser,
    @Body() body: McpServerInput & { credential?: string },
  ): Promise<McpServerView> {
    const { credential, ...input } = body ?? ({} as McpServerInput);
    const view = await this.servers.create(input, credential || undefined, actor(user));
    await this.record(user, 'assistant.mcp_server.created', view);
    return view;
  }

  @Put(':id')
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: Partial<McpServerInput> & { credential?: string },
  ): Promise<McpServerView> {
    const { credential, ...patch } = body ?? {};
    const view = await this.servers.update(id, patch, credential, actor(user));
    await this.record(user, 'assistant.mcp_server.updated', view, { credentialChanged: credential !== undefined });
    return view;
  }

  @Delete(':id')
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<{ ok: true }> {
    const view = await this.servers.getView(id);
    await this.servers.remove(id, actor(user));
    await this.record(user, 'assistant.mcp_server.deleted', view);
    return { ok: true };
  }

  /** Connect, list the server's tools, and pin them (re-approve after the server changes). */
  @Post(':id/refresh')
  async refresh(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<McpServerView> {
    const view = await this.servers.refresh(id);
    await this.record(user, 'assistant.mcp_server.refreshed', view, {
      tools: view.tools.map((t) => t.name),
      error: view.lastError,
    });
    return view;
  }

  private record(user: SessionUser, action: string, view: McpServerView, extra: Record<string, unknown> = {}) {
    return this.audit
      .record({
        actorId: user.id,
        actorEmail: user.email,
        action,
        target: view.id,
        meta: { name: view.name, url: view.url, authType: view.authType, ...extra },
      })
      .catch(() => undefined);
  }
}

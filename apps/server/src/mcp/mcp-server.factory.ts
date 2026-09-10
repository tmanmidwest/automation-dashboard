import { Injectable, Logger } from '@nestjs/common';
// The specifier below is what Node resolves at runtime (via the SDK's `exports`);
// a `paths` mapping in tsconfig.json redirects *type* resolution to the physical CJS
// `.d.ts`, because the server compiles with classic (`Node10`) resolution, which
// rejects bare deep imports into a package that declares `exports`.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionUser } from '@cerebro/shared';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { AuditService } from '../logging/audit.service';
import { LoggingService } from '../logging/logging.service';

const SERVER_NAME = 'cerebro';

/** Identifies the credential a tool call arrived on, for the audit trail. */
export interface McpOrigin {
  tokenId?: string;
  oauthClientId?: string;
}

/**
 * Builds an MCP server scoped to a single caller. The tools themselves come from the
 * shared {@link ToolCatalogService} (also consumed by the in-app assistant), already
 * filtered to the caller's permissions. This factory only adds the MCP transport
 * concerns: JSON-text wrapping, per-call logging, the confirm gate for state-changing
 * tools, and audit tagging. See docs/assistant-computer.md.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);

  constructor(
    private readonly catalog: ToolCatalogService,
    private readonly audit: AuditService,
    private readonly logging: LoggingService,
  ) {}

  build(user: SessionUser, origin: McpOrigin = {}): McpServer {
    const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });

    // Wraps a read tool body so thrown errors become a clean MCP error result rather
    // than crashing the request, and successful results become JSON text content.
    const tool = (
      name: string,
      config: { description: string; inputSchema?: z.ZodRawShape },
      run: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const handler = async (args: unknown) => {
        try {
          const data = await run((args ?? {}) as Record<string, unknown>);
          const text = JSON.stringify(data, null, 2);
          // Record what Cerebro actually returned, so we can tell server-side output
          // apart from client-side truncation (e.g. a small local model showing fewer rows).
          const count = Array.isArray(data) ? data.length : undefined;
          void this.logging.info(
            'mcp',
            `tool: ${name}${count !== undefined ? ` → ${count} items` : ''} (${text.length} bytes)`,
            { user: user.email, items: count, bytes: text.length },
          );
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void this.logging.warn('mcp', `tool ${name} failed: ${message}`, { user: user.email });
          return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
        }
      };
      // Cast around the SDK's deeply-generic registerTool overloads (TS2589).
      (server.registerTool as (n: string, c: unknown, h: typeof handler) => unknown)(name, config, handler);
    };

    // A state-changing tool. Adds MCP annotations (so clients prompt) and, when
    // `confirm` is set (default true), requires a `confirm: true` argument before running —
    // a client-agnostic guardrail. Every successful call is written to the audit trail,
    // tagged with the MCP origin, since these bypass the controllers that normally audit.
    const actionTool = (
      name: string,
      config: { description: string; inputSchema: z.ZodRawShape; destructive?: boolean; confirm?: boolean },
      run: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const needsConfirm = config.confirm !== false;
      // `confirm` is optional in the schema (so an omitted value reaches the handler and
      // gets the clear refusal below, rather than a raw schema-validation error).
      const inputSchema = needsConfirm
        ? { ...config.inputSchema, confirm: z.boolean().optional().describe('Must be set to true to execute this state-changing action.') }
        : config.inputSchema;

      const handler = async (rawArgs: unknown) => {
        const args = (rawArgs ?? {}) as Record<string, unknown> & { confirm?: boolean };
        if (needsConfirm && args.confirm !== true) {
          void this.logging.info('mcp', `action refused (no confirm): ${name}`, { user: user.email });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Refused: "${name}" changes state. Re-call with confirm: true to proceed. (${config.description})` }],
          };
        }
        void this.logging.info('mcp', `action: ${name}`, { user: user.email });
        try {
          const data = await run(args);
          await this.recordAudit(user, origin, name, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void this.logging.warn('mcp', `action ${name} failed: ${message}`, { user: user.email });
          return { isError: true, content: [{ type: 'text' as const, text: `Error: ${message}` }] };
        }
      };

      const toolConfig = {
        description: config.description,
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: !!config.destructive },
      };
      (server.registerTool as (n: string, c: unknown, h: typeof handler) => unknown)(name, toolConfig, handler);
    };

    // Register every tool the caller is permitted to use, from the shared catalog.
    for (const t of this.catalog.build(user)) {
      if (t.kind === 'read') {
        tool(t.name, { description: t.description, inputSchema: t.inputSchema }, t.run);
      } else {
        actionTool(
          t.name,
          { description: t.description, inputSchema: t.inputSchema, destructive: t.destructive, confirm: t.confirm },
          t.run,
        );
      }
    }

    return server;
  }

  /** Record an MCP-initiated action to the audit trail (services don't audit; controllers do). */
  private async recordAudit(user: SessionUser, origin: McpOrigin, toolName: string, args: Record<string, unknown>) {
    const { confirm: _confirm, ...meta } = args;
    const target = String(args.resourceId ?? args.monitorId ?? args.ruleId ?? args.operationId ?? args.jobId ?? args.instanceId ?? '');
    await this.audit
      .record({
        actorId: user.id,
        actorEmail: user.email,
        action: `mcp.${toolName}`,
        target: target || null,
        meta: { ...meta, via: 'mcp', tokenId: origin.tokenId, oauthClientId: origin.oauthClientId },
      })
      .catch(() => undefined);
  }
}

import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { SessionUser } from '@cerebro/shared';
import { McpServerFactory } from './mcp-server.factory';
import { LoggingService } from '../logging/logging.service';

/**
 * MCP endpoint (Streamable HTTP transport), mounted in-process at `/mcp`.
 *
 * Authentication is handled by the global SessionAuthGuard: the request must carry a
 * valid bearer API token (or session), and `req.user` arrives with permissions already
 * narrowed to the token's scopes. We run stateless — a fresh MCP server + transport per
 * request — so each connection sees exactly the tools its scopes allow. Not @SessionOnly:
 * this is the primary bearer-token consumer.
 */
@Controller('mcp')
export class McpController {
  constructor(
    private readonly factory: McpServerFactory,
    private readonly logging: LoggingService,
  ) {}

  @All()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const user = req.user as SessionUser; // guaranteed by the global auth guard

    // Log the JSON-RPC method + who's calling, so MCP activity is visible in the Logs UI.
    const body = req.body as { method?: string } | undefined;
    this.logging.info('mcp', `request: ${body?.method ?? req.method}`, {
      user: user.email,
      principal: req.principalType,
      tokenId: req.apiTokenId,
      clientId: req.oauthClientId,
    });

    const server = this.factory.build(user, { tokenId: req.apiTokenId, oauthClientId: req.oauthClientId });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    // Tear down per-request resources once the response is done.
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    await server.connect(transport);
    // Nest has already parsed the JSON body; hand it to the transport.
    await transport.handleRequest(req, res, req.body);
  }
}

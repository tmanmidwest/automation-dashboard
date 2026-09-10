import { Body, Controller, Get, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  AssistantChatMessage,
  AssistantChatRequest,
  AssistantConfig,
  AssistantConfigView,
  AssistantModelInfo,
  AssistantProposeRuleRequest,
  AssistantResumeRequest,
  AssistantRuleProposal,
  GpuStatus,
  OllamaCertOption,
  OllamaDeployRequest,
  OllamaHost,
  SessionUser,
} from '@cerebro/shared';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import { AssistantService } from './assistant.service';
import { AssistantConfigService } from './assistant-config.service';
import { OllamaProvisionService } from './ollama-provision.service';

/**
 * The Computer — in-app LLM assistant. Session-only (never a bearer-token surface): it
 * runs tools as the logged-in operator. See docs/assistant-computer.md.
 */
@Controller('api/assistant')
@SessionOnly()
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly config: AssistantConfigService,
    private readonly ollama: OllamaProvisionService,
  ) {}

  /** Current assistant configuration (no secret values). */
  @Get('config')
  @RequirePermissions('assistant:use')
  getConfig(): Promise<AssistantConfigView> {
    return this.config.getView();
  }

  /** Update assistant configuration. */
  @Put('config')
  @RequirePermissions('settings:write')
  updateConfig(@Body() body: Partial<AssistantConfig> & { apiKey?: string }): Promise<AssistantConfigView> {
    const { apiKey, ...patch } = body;
    return this.applyConfig(patch, apiKey);
  }

  private async applyConfig(patch: Partial<AssistantConfig>, apiKey?: string): Promise<AssistantConfigView> {
    if (apiKey !== undefined) await this.config.setApiKey(apiKey);
    return this.config.update(patch);
  }

  /** Models the configured backend advertises (for the settings dropdown). */
  @Get('models')
  @RequirePermissions('settings:write')
  listModels(): Promise<AssistantModelInfo[]> {
    return this.config.listModels();
  }

  /** Docker connector hosts that can run a Cerebro-deployed Ollama container. */
  @Get('ollama/hosts')
  @RequirePermissions('settings:write')
  ollamaHosts(): Promise<OllamaHost[]> {
    return this.ollama.hosts();
  }

  /** Nginx Proxy Manager instances that can front the deployed Ollama. */
  @Get('ollama/proxies')
  @RequirePermissions('settings:write')
  ollamaProxies(): Promise<OllamaHost[]> {
    return this.ollama.proxies();
  }

  /** Certificates offered by an NPM instance (for the reverse-proxy option). */
  @Get('ollama/proxy-certs')
  @RequirePermissions('settings:write')
  ollamaProxyCerts(@Query('instanceId') instanceId: string): Promise<OllamaCertOption[]> {
    return this.ollama.proxyCerts(String(instanceId ?? ''));
  }

  /** Probe a Docker host's GPU readiness (driver / toolkit / runtime). */
  @Get('ollama/gpu-status')
  @RequirePermissions('settings:write')
  gpuStatus(@Query('instanceId') instanceId: string): Promise<GpuStatus> {
    return this.ollama.gpuStatus(String(instanceId ?? ''));
  }

  /** Install the NVIDIA Container Toolkit on a Debian/Ubuntu Docker host, streaming progress. */
  @Post('ollama/install-toolkit')
  @RequirePermissions('settings:write')
  async installToolkit(
    @Body() body: { instanceId?: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(req, res, this.ollama.installToolkit(String(body?.instanceId ?? '')));
  }

  /** Deploy (or reuse) an Ollama container on a Docker host, streaming progress as SSE. */
  @Post('ollama/deploy')
  @RequirePermissions('settings:write')
  async ollamaDeploy(
    @Body() body: OllamaDeployRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.stream(req, res, this.ollama.deploy({
      instanceId: String(body?.instanceId ?? ''),
      port: Number(body?.port) || 11434,
      gpu: body?.gpu === true,
      model: body?.model ? String(body.model) : undefined,
      baseUrlOverride: body?.baseUrlOverride ? String(body.baseUrlOverride) : undefined,
      recreate: body?.recreate === true,
      proxy: body?.proxy?.instanceId && body?.proxy?.domain
        ? {
            instanceId: String(body.proxy.instanceId),
            domain: String(body.proxy.domain),
            certificateId: Number(body.proxy.certificateId) || 0,
            sslForced: body.proxy.sslForced === true,
          }
        : undefined,
    }));
  }

  /** Draft an automation rule from a natural-language description (for the rule builder). */
  @Post('propose-rule')
  @RequirePermissions('automations:write')
  proposeRule(
    @CurrentUser() user: SessionUser,
    @Body() body: AssistantProposeRuleRequest,
  ): Promise<AssistantRuleProposal> {
    return this.assistant.proposeRule(user, String(body?.prompt ?? ''));
  }

  /**
   * Stream a chat reply. POST (so the conversation history rides in the body) with a
   * Server-Sent-Events response the client reads via fetch + a stream reader. Each frame
   * is `data: <AssistantStreamEvent JSON>\n\n`.
   */
  @Post('chat')
  @RequirePermissions('assistant:use')
  async chat(
    @CurrentUser() user: SessionUser,
    @Body() body: AssistantChatRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const history = sanitizeHistory(body?.messages);
    await this.stream(req, res, this.assistant.chat(user, history));
  }

  /**
   * Resume a turn paused by the confirm gate: approve or deny the pending action, then the
   * loop continues, streamed as SSE just like /chat.
   */
  @Post('resume')
  @RequirePermissions('assistant:use')
  async resume(
    @CurrentUser() user: SessionUser,
    @Body() body: AssistantResumeRequest,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const pendingId = String(body?.pendingId ?? '');
    const approve = body?.approve === true;
    await this.stream(req, res, this.assistant.resume(user, pendingId, approve));
  }

  /** Pipe an event stream to the client as Server-Sent Events. Any discriminated-union
   *  event with a `type` works — assistant chat, resume, or ollama deploy. */
  private async stream(
    req: Request,
    res: Response,
    events: AsyncIterable<{ type: string }>,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let a reverse proxy buffer the stream
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    const send = (event: unknown) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of events) {
        if (closed) break;
        send(event);
        // confirm_required and done/error all terminate this HTTP turn; the client
        // opens a new /resume stream to continue after a confirm.
        if (event.type === 'done' || event.type === 'error' || event.type === 'confirm_required') break;
      }
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!closed) res.end();
    }
  }
}

/** Keep only well-formed user/assistant turns with string content. */
function sanitizeHistory(messages: unknown): AssistantChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m): m is AssistantChatMessage =>
        !!m &&
        typeof (m as AssistantChatMessage).content === 'string' &&
        ((m as AssistantChatMessage).role === 'user' || (m as AssistantChatMessage).role === 'assistant'),
    )
    .slice(-40); // cap history length
}

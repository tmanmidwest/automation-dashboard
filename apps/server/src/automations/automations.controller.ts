import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { AutomationsService } from './automations.service';
import { CurrentUser, RequirePermissions, SessionOnly } from '../auth/decorators';
import type { AutomationRuleInput, SessionUser } from '@cerebro/shared';

/**
 * Automation rules API. Session-only — a rule can run infrastructure actions, so
 * it's never reachable with a bearer token (automations:* isn't a grantable scope).
 */
@Controller('api/automations')
@SessionOnly()
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  @RequirePermissions('automations:read')
  list() {
    return this.automations.list();
  }

  @Get('runs')
  @RequirePermissions('automations:read')
  runs(@Query('ruleId') ruleId?: string, @Query('limit') limit?: string) {
    return this.automations.runs(ruleId || undefined, limit ? parseInt(limit, 10) : undefined);
  }

  @Get(':id')
  @RequirePermissions('automations:read')
  async getOne(@Param('id') id: string) {
    const r = await this.automations.get(id);
    if (!r) throw new NotFoundException('Rule not found.');
    return r;
  }

  @Post()
  @RequirePermissions('automations:write')
  create(@Body() body: AutomationRuleInput, @CurrentUser() user: SessionUser) {
    validate(body);
    return this.automations.create(body, ctx(user));
  }

  @Put(':id')
  @RequirePermissions('automations:write')
  update(@Param('id') id: string, @Body() body: Partial<AutomationRuleInput>, @CurrentUser() user: SessionUser) {
    if (body.trigger) validateTrigger(body.trigger);
    return this.automations.update(id, body, ctx(user));
  }

  @Delete(':id')
  @RequirePermissions('automations:write')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.automations.remove(id, ctx(user));
    return { ok: true };
  }

  @Post(':id/test')
  @RequirePermissions('automations:write')
  test(@Param('id') id: string) {
    return this.automations.test(id);
  }
}

function ctx(user: SessionUser) {
  return { actorId: user.id, actorEmail: user.email };
}

function validate(body: AutomationRuleInput) {
  if (!body?.name?.trim()) throw new BadRequestException('A name is required.');
  validateTrigger(body.trigger);
  if (!Array.isArray(body.actions) || body.actions.length === 0) throw new BadRequestException('At least one action is required.');
  for (const a of body.actions) {
    if ((a.type === 'pause_monitor' || a.type === 'resume_monitor') && !a.monitorId) throw new BadRequestException('Select a monitor for the pause/resume action.');
    if (a.type === 'webhook' && !/^https?:\/\//i.test(a.url ?? '')) throw new BadRequestException('The webhook action needs an http(s) URL.');
    if (a.type === 'connector_action' && (!a.instanceId || !a.kind || !a.actionId)) throw new BadRequestException('The connector action needs a connector, kind and action.');
    if (a.type === 'connector_operation' && (!a.instanceId || !a.operationId)) throw new BadRequestException('The connector operation needs a connector and operation.');
  }
}

function validateTrigger(trigger: AutomationRuleInput['trigger']) {
  if (!trigger || (trigger.type !== 'event' && trigger.type !== 'schedule')) {
    throw new BadRequestException('A valid trigger (event or schedule) is required.');
  }
  if (trigger.type === 'schedule' && !trigger.cron?.trim()) {
    throw new BadRequestException('A schedule trigger needs a cron expression.');
  }
}

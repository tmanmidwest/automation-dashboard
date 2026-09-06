import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Subscription } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { AuditService } from '../logging/audit.service';
import { TimelineBus } from '../timeline/timeline-bus';
import { NotificationsService } from '../notifications/notifications.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import type {
  AutomationRule,
  AutomationRuleInput,
  RuleAction,
  RuleCondition,
  RuleTrigger,
  TimelineEvent,
} from '@cerebro/shared';

interface ActorCtx {
  actorId?: string | null;
  actorEmail?: string | null;
}

/**
 * The rules engine: WHEN a timeline event (or schedule) fires, IF the conditions
 * hold, DO the actions. Subscribes to the in-process TimelineBus for event
 * triggers and a per-minute cron for schedule triggers. See docs/automations.md.
 */
@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  /** Enabled rules cached in memory (events can be frequent); refreshed on CRUD. */
  private cache: AutomationRule[] = [];
  /** ruleId → last fired epoch ms (cooldown guard). */
  private readonly lastFired = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
    private readonly audit: AuditService,
    private readonly bus: TimelineBus,
    private readonly notifications: NotificationsService,
    private readonly instances: ConnectorInstanceService,
  ) {}

  async onModuleInit() {
    await this.refresh().catch(() => {});
    this.sub = this.bus.stream({}).subscribe((e) => void this.onEvent(e));
  }
  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  // ── CRUD ────────────────────────────────────────────────────────

  private toRule = (r: {
    id: string; name: string; enabled: boolean; trigger: unknown; conditions: unknown; actions: unknown;
    cooldownSec: number; lastFiredAt: Date | null; createdAt: Date; updatedAt: Date;
  }): AutomationRule => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger as RuleTrigger,
    conditions: (r.conditions as RuleCondition[]) ?? [],
    actions: (r.actions as RuleAction[]) ?? [],
    cooldownSec: r.cooldownSec,
    lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });

  async list(): Promise<AutomationRule[]> {
    const rows = await this.prisma.automationRule.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(this.toRule);
  }

  async get(id: string): Promise<AutomationRule | null> {
    const r = await this.prisma.automationRule.findUnique({ where: { id } });
    return r ? this.toRule(r) : null;
  }

  async create(input: AutomationRuleInput, ctx?: ActorCtx): Promise<AutomationRule> {
    const r = await this.prisma.automationRule.create({
      data: {
        name: input.name.trim(),
        enabled: input.enabled ?? true,
        trigger: input.trigger as object,
        conditions: (input.conditions ?? []) as object,
        actions: (input.actions ?? []) as object,
        cooldownSec: clampCooldown(input.cooldownSec),
      },
    });
    await this.refresh();
    await this.record(ctx, 'automation.rule_created', r.name);
    return this.toRule(r);
  }

  async update(id: string, input: Partial<AutomationRuleInput>, ctx?: ActorCtx): Promise<AutomationRule> {
    const r = await this.prisma.automationRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger as object } : {}),
        ...(input.conditions !== undefined ? { conditions: input.conditions as object } : {}),
        ...(input.actions !== undefined ? { actions: input.actions as object } : {}),
        ...(input.cooldownSec !== undefined ? { cooldownSec: clampCooldown(input.cooldownSec) } : {}),
      },
    });
    await this.refresh();
    await this.record(ctx, 'automation.rule_updated', r.name);
    return this.toRule(r);
  }

  async remove(id: string, ctx?: ActorCtx): Promise<void> {
    const r = await this.prisma.automationRule.findUnique({ where: { id } });
    await this.prisma.automationRule.delete({ where: { id } });
    this.lastFired.delete(id);
    await this.refresh();
    if (r) await this.record(ctx, 'automation.rule_deleted', r.name);
  }

  async runs(ruleId?: string, limit = 100): Promise<import('@cerebro/shared').AutomationRun[]> {
    const rows = await this.prisma.automationRun.findMany({
      where: ruleId ? { ruleId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
    return rows.map((r) => ({
      id: r.id, ruleId: r.ruleId, ruleName: r.ruleName, trigger: r.trigger,
      status: r.status as import('@cerebro/shared').AutomationRunStatus, message: r.message, createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Run a rule's actions on demand (build/verify), regardless of trigger/cooldown. */
  async test(id: string): Promise<{ status: string; message: string }> {
    const rule = await this.get(id);
    if (!rule) throw new Error('Rule not found.');
    return this.fire(rule, 'Manual test', true);
  }

  private async refresh() {
    this.cache = (await this.list()).filter((r) => r.enabled);
  }

  // ── Evaluation ──────────────────────────────────────────────────

  private async onEvent(event: TimelineEvent): Promise<void> {
    // Loop guard: never react to events an automation itself produced.
    if ((event.meta as { automation?: unknown } | null)?.automation) return;
    for (const rule of this.cache) {
      if (rule.trigger.type !== 'event') continue;
      if (!matchesEvent(rule.trigger, event)) continue;
      if (!conditionsHold(rule.conditions, event.severity)) continue;
      void this.fire(rule, describeEvent(event), false);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduleTick(): Promise<void> {
    const now = new Date();
    for (const rule of this.cache) {
      if (rule.trigger.type !== 'schedule') continue;
      if (!conditionsHold(rule.conditions, 'info')) continue;
      if (matchCron(rule.trigger.cron, now)) void this.fire(rule, `Schedule ${rule.trigger.cron}`, false);
    }
  }

  /** Execute a rule's actions (honouring cooldown unless forced), record the run. */
  private async fire(rule: AutomationRule, triggerDesc: string, forced: boolean): Promise<{ status: string; message: string }> {
    if (!forced) {
      const last = this.lastFired.get(rule.id) ?? 0;
      if (Date.now() - last < rule.cooldownSec * 1000) return { status: 'skipped', message: 'cooldown' };
    }
    this.lastFired.set(rule.id, Date.now());

    const results: { ok: boolean; msg: string }[] = [];
    for (const action of rule.actions) {
      try {
        results.push({ ok: true, msg: await this.runAction(action) });
      } catch (err) {
        results.push({ ok: false, msg: err instanceof Error ? err.message : 'action failed' });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const status = results.length === 0 ? 'skipped' : okCount === results.length ? 'success' : okCount === 0 ? 'error' : 'partial';
    const message = results.map((r) => `${r.ok ? '✓' : '✗'} ${r.msg}`).join(' · ') || 'no actions';

    await this.prisma.automationRun
      .create({ data: { ruleId: rule.id, ruleName: rule.name, trigger: triggerDesc.slice(0, 300), status, message: message.slice(0, 1000) } })
      .catch(() => {});
    await this.prisma.automationRule.update({ where: { id: rule.id }, data: { lastFiredAt: new Date() } }).catch(() => {});
    // Audit (tagged automation:true so it never re-triggers a rule).
    await this.audit
      .record({ action: `automation.${status}`, target: rule.name, meta: { automation: true, ruleId: rule.id, trigger: triggerDesc } })
      .catch(() => {});
    void this.logging.info('automations', `Rule "${rule.name}" (${triggerDesc}) → ${status}: ${message}`);
    return { status, message };
  }

  private async runAction(action: RuleAction): Promise<string> {
    switch (action.type) {
      case 'notify':
        await this.notifications.dispatchAlert('automation.notify', {
          title: action.title,
          body: action.body ?? '',
          dedupeKey: `automation.notify:${action.title}`,
        });
        return `notified: ${action.title}`;
      case 'connector_action': {
        const res = await this.instances.performAction(action.instanceId, action.kind, action.resourceId, action.actionId);
        if (!res.ok) throw new Error(`action ${action.actionId}: ${res.message}`);
        return `${action.actionId} ${action.resourceId}`;
      }
      case 'connector_operation': {
        const jobId = await this.instances.startOperation(action.instanceId, action.operationId, action.resourceId, action.values ?? {});
        return `operation ${action.operationId} (job ${jobId.slice(0, 8)})`;
      }
      default:
        throw new Error('unknown action type');
    }
  }

  private record(ctx: ActorCtx | undefined, action: string, target: string) {
    if (!ctx?.actorId && !ctx?.actorEmail) return Promise.resolve();
    return this.audit.record({ actorId: ctx.actorId, actorEmail: ctx.actorEmail, action, target }).catch(() => {});
  }
}

// ── Pure helpers ──────────────────────────────────────────────────

const SEV_RANK: Record<string, number> = { success: 0, info: 0, warning: 1, critical: 2 };

function matchesEvent(t: Extract<RuleTrigger, { type: 'event' }>, e: TimelineEvent): boolean {
  if (t.kinds?.length && !t.kinds.includes(e.kind)) return false;
  if (t.severities?.length && !t.severities.includes(e.severity)) return false;
  if (t.source && !(e.source ?? '').toLowerCase().includes(t.source.toLowerCase())) return false;
  if (t.textContains) {
    const hay = `${e.title} ${e.detail ?? ''}`.toLowerCase();
    if (!hay.includes(t.textContains.toLowerCase())) return false;
  }
  return true;
}

function conditionsHold(conditions: RuleCondition[], eventSeverity: string): boolean {
  for (const c of conditions) {
    if (c.type === 'severity_at_least') {
      if ((SEV_RANK[eventSeverity] ?? 0) < (SEV_RANK[c.severity] ?? 0)) return false;
    } else if (c.type === 'time_window') {
      if (!inTimeWindow(c.start, c.end)) return false;
    }
  }
  return true;
}

/** True if the current server-local time is within [start,end] (HH:MM), wrapping past midnight. */
function inTimeWindow(start: string, end: string): boolean {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return true;
  return s <= e ? cur >= s && cur <= e : cur >= s || cur <= e;
}
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minimal 5-field cron match (min hour dom month dow): supports wildcards, step (slash-N), ranges, and comma lists. */
function matchCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return parts.every((spec, i) => matchCronField(spec, fields[i]));
}
function matchCronField(spec: string, value: number): boolean {
  if (spec === '*') return true;
  return spec.split(',').some((part) => {
    const step = part.includes('/') ? Number(part.split('/')[1]) : 1;
    const range = part.split('/')[0];
    if (range === '*') return step > 0 && value % step === 0;
    if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      return value >= a && value <= b && (value - a) % (step || 1) === 0;
    }
    return Number(range) === value;
  });
}

function describeEvent(e: TimelineEvent): string {
  return `${e.kind}/${e.severity}: ${e.title}`.slice(0, 200);
}

function clampCooldown(v?: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(86400, Math.floor(n))) : 60;
}

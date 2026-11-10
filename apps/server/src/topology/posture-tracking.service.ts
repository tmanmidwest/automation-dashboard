import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PostureEventView, PostureFinding, TopologyGraph } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { LoggingService } from '../logging/logging.service';
import { SettingsService } from '../settings/settings.service';
import { annotate, listLabels, planSync, type FindingRec } from './posture-tracking';

/** Where finding-level snoozes lived before per-item tracking; converted once, then removed. */
const LEGACY_SNOOZE_KEY = 'posture.snoozes';
/** History kept per finding. */
const MAX_EVENTS = 200;

export type ItemAction = 'snooze' | 'accept' | 'reopen';

/**
 * Remembers posture findings between map builds: first seen / fixed, per-item snooze and
 * accepted risk, and a history per finding. See docs/posture.md.
 */
@Injectable()
export class PostureTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
    private readonly settings: SettingsService,
  ) {}

  private legacyDone = false;
  private syncing: Promise<void> = Promise.resolve();

  private async records(ids?: string[]): Promise<FindingRec[]> {
    return this.prisma.postureFindingRecord.findMany({
      where: ids ? { id: { in: ids } } : undefined,
      select: { id: true, severity: true, title: true, firstSeenAt: true, resolvedAt: true, items: true },
    });
  }

  /** Record a fresh build's findings. Runs one at a time; failures are logged, never thrown. */
  sync(findings: PostureFinding[], trustGone: boolean): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync(findings, trustGone)).catch((err) => {
      void this.logging.warn('posture', `Could not record posture findings: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.syncing;
  }

  private async doSync(findings: PostureFinding[], trustGone: boolean): Promise<void> {
    const now = new Date();
    const plan = planSync(findings, await this.records(), now, trustGone);
    const snap = (f: PostureFinding) => JSON.parse(JSON.stringify({ ...f, snoozedUntil: undefined })) as Prisma.InputJsonValue;
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const u of plan.upserts) {
      const data = { severity: u.finding.severity, category: u.finding.category, title: u.finding.title, source: u.finding.source, snapshot: snap(u.finding), lastSeenAt: now };
      ops.push(u.create
        ? this.prisma.postureFindingRecord.create({ data: { id: u.finding.id, ...data, firstSeenAt: now } })
        : this.prisma.postureFindingRecord.update({ where: { id: u.finding.id }, data: { ...data, ...(u.reopen ? { resolvedAt: null } : {}) } }));
    }
    if (plan.newItems.length) ops.push(this.prisma.postureItemRecord.createMany({ data: plan.newItems.map((i) => ({ ...i, firstSeenAt: now })), skipDuplicates: true }));
    for (const p of plan.itemPatches) ops.push(this.prisma.postureItemRecord.update({ where: { findingId_label: { findingId: p.findingId, label: p.label } }, data: p.patch }));
    if (plan.resolve.length) ops.push(this.prisma.postureFindingRecord.updateMany({ where: { id: { in: plan.resolve } }, data: { resolvedAt: now } }));
    if (plan.events.length) ops.push(this.prisma.postureEvent.createMany({ data: plan.events.map((e, i) => ({ ...e, at: new Date(now.getTime() + i) })) /* +i ms keeps their order */ }));
    if (ops.length) await this.prisma.$transaction(ops);
    if (!this.legacyDone) await this.convertLegacySnoozes(findings);
  }

  /** Finding-level snoozes from before become item snoozes on the items they covered. */
  private async convertLegacySnoozes(findings: PostureFinding[]): Promise<void> {
    this.legacyDone = true;
    const old = (await this.settings.get<Record<string, { until: string; labels: string[] }>>(LEGACY_SNOOZE_KEY)) ?? {};
    const live = Object.entries(old).filter(([, s]) => s && new Date(s.until).getTime() > Date.now());
    for (const [id, s] of live) {
      if (!findings.some((f) => f.id === id)) continue;
      const days = Math.max(1, Math.ceil((new Date(s.until).getTime() - Date.now()) / 86_400_000));
      await this.setItems(id, s.labels, 'snooze', { days, eventText: `Snooze from before the Posture page carried over to ${listLabels(s.labels)}` }).catch(() => undefined);
    }
    if (Object.keys(old).length) await this.settings.set(LEGACY_SNOOZE_KEY, {});
  }

  /** Fresh findings plus what's recorded about them. */
  async annotate(findings: PostureFinding[], graph: Pick<TopologyGraph, 'nodes'>): Promise<PostureFinding[]> {
    try {
      return annotate(findings, await this.records(findings.map((f) => f.id)), graph);
    } catch {
      // Table missing (before the migration ran): show them untracked.
      return annotate(findings, [], graph);
    }
  }

  /**
   * Snooze, accept or reopen some of a finding's items. `labels` empty = every item that is
   * open (for snooze / accept) or set aside (for reopen). Returns how many changed.
   */
  async setItems(
    findingId: string,
    labels: string[],
    action: ItemAction,
    opts: { days?: number; note?: string; actor?: string; severity?: string; eventText?: string } = {},
  ): Promise<number> {
    const rec = await this.prisma.postureFindingRecord.findUnique({ where: { id: findingId }, include: { items: { where: { goneAt: null } } } });
    if (!rec || rec.resolvedAt) return 0;
    const now = new Date();
    const want = new Set(labels);
    const active = (i: { status: string; until: Date | null }) => i.status !== 'open' && !(i.until && i.until.getTime() <= now.getTime());
    const targets = rec.items.filter((i) => (labels.length ? want.has(i.label) : action === 'reopen' ? active(i) : !active(i)));
    if (!targets.length) return 0;
    const until = opts.days ? new Date(now.getTime() + opts.days * 86_400_000) : null;
    const data =
      action === 'reopen'
        ? { status: 'open', until: null, note: null, setBy: null, setAt: null, acceptedSeverity: null }
        : action === 'snooze'
          ? { status: 'snoozed', until: until ?? new Date(now.getTime() + 7 * 86_400_000), note: opts.note?.trim() || null, setBy: opts.actor ?? null, setAt: now, acceptedSeverity: null }
          : { status: 'accepted', until, note: opts.note?.trim() || null, setBy: opts.actor ?? null, setAt: now, acceptedSeverity: opts.severity ?? rec.severity };
    const names = targets.map((t) => t.label);
    const who = opts.actor ?? 'Someone';
    const what = names.length === rec.items.length && names.length > 1 ? `all ${names.length} items` : listLabels(names);
    const text = opts.eventText ?? (
      action === 'reopen'
        ? `${who} reopened ${what}`
        : action === 'snooze'
          ? `${who} snoozed ${what} until ${data.until!.toISOString().slice(0, 10)}`
          : `${who} accepted the risk on ${what}${until ? ` until ${until.toISOString().slice(0, 10)}` : ''}${data.note ? `: "${data.note}"` : ''}`);
    await this.prisma.$transaction([
      this.prisma.postureItemRecord.updateMany({ where: { findingId, label: { in: names } }, data }),
      this.prisma.postureEvent.create({ data: { findingId, kind: action === 'reopen' ? 'reopened' : action === 'snooze' ? 'snoozed' : 'accepted', text, actor: opts.actor ?? null } }),
    ]);
    void this.trimEvents(findingId);
    return names.length;
  }

  private async trimEvents(findingId: string): Promise<void> {
    const old = await this.prisma.postureEvent.findMany({ where: { findingId }, orderBy: { at: 'desc' }, skip: MAX_EVENTS, select: { id: true } });
    if (old.length) await this.prisma.postureEvent.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }

  /** Findings fixed in the last `days` days, as they last looked. */
  async fixed(days: number): Promise<PostureFinding[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.postureFindingRecord.findMany({ where: { resolvedAt: { gte: since } }, orderBy: { resolvedAt: 'desc' }, take: 200 });
    return rows.map((r) => ({
      ...(r.snapshot as unknown as PostureFinding),
      affected: ((r.snapshot as unknown as PostureFinding).affected ?? []).map((a) => ({ ...a, status: undefined, until: undefined, reason: undefined })),
      status: 'fixed' as const,
      snoozedUntil: undefined,
      firstSeenAt: r.firstSeenAt.toISOString(),
      resolvedAt: r.resolvedAt!.toISOString(),
    }));
  }

  async history(findingId: string): Promise<PostureEventView[]> {
    const rows = await this.prisma.postureEvent.findMany({ where: { findingId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 100 });
    return rows.map((r) => ({ at: r.at.toISOString(), kind: r.kind, text: r.text, actor: r.actor ?? undefined }));
  }
}

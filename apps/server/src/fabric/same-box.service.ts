import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRegistryService } from './agent-registry.service';
import { computeSameBox, type SameBoxPeer, type SameBoxResult } from './same-box';

type Listener = (changedAgentIds: string[]) => void;

/**
 * Caches which Waypoints share a machine with an endpoint agent (see same-box.ts)
 * so Health, OS updates and Posture can treat that machine once. Recomputed every
 * minute and whenever an agent sends fresh inventory.
 */
@Injectable()
export class SameBoxService implements OnModuleInit {
  private readonly logger = new Logger(SameBoxService.name);
  private result: SameBoxResult = { deferring: new Map(), companions: new Map() };
  private readonly listeners: Listener[] = [];
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AgentRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch(() => undefined);
  }

  /** Called with the agent ids whose deferral changed (both sides of each pair). */
  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  /** The endpoint agent this Waypoint defers to, or null. */
  deferredTo(agentId: string): SameBoxPeer | null {
    return this.result.deferring.get(agentId) ?? null;
  }

  isDeferring(agentId: string): boolean {
    return this.result.deferring.has(agentId);
  }

  /** Waypoints on the same machine that defer to this endpoint agent. */
  companionsOf(agentId: string): SameBoxPeer[] {
    return this.result.companions.get(agentId) ?? [];
  }

  deferringIds(): Set<string> {
    return new Set(this.result.deferring.keys());
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    await this.refresh().catch((e) => this.logger.warn(`Same-box check failed: ${e instanceof Error ? e.message : e}`));
  }

  /** Recompute now (coalesces concurrent calls). */
  refresh(): Promise<void> {
    if (!this.inflight) this.inflight = this.compute().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async compute(): Promise<void> {
    const rows = await this.prisma.agent.findMany({
      where: { status: { notIn: ['pending', 'revoked', 'deleting'] } },
      select: { id: true, name: true, mode: true, hostname: true, status: true, lastSeenAt: true, health: { select: { inventory: true } } },
    });
    const next = computeSameBox(
      rows.map((a) => {
        const inv = (a.health?.inventory ?? null) as { hostname?: unknown; macs?: unknown } | null;
        return {
          id: a.id,
          name: a.name,
          mode: a.mode,
          hostname: a.hostname,
          invHostname: typeof inv?.hostname === 'string' ? inv.hostname : null,
          macs: Array.isArray(inv?.macs) ? (inv!.macs as unknown[]).filter((m): m is string => typeof m === 'string') : [],
          online: this.registry.statusOf(a.id, a.status) === 'online',
          lastSeenAt: a.lastSeenAt,
        };
      }),
    );
    const changed = new Set<string>();
    const keyOf = (r: SameBoxResult, id: string) => r.deferring.get(id)?.agentId ?? '';
    for (const id of new Set([...this.result.deferring.keys(), ...next.deferring.keys()])) {
      const before = keyOf(this.result, id);
      const after = keyOf(next, id);
      if (before === after) continue;
      changed.add(id);
      if (before) changed.add(before);
      if (after) changed.add(after);
      if (after) this.logger.log(`Waypoint ${id} shares a machine with agent ${after}: it now defers health and OS updates to it`);
      else this.logger.log(`Waypoint ${id} reports health again (no endpoint agent beside it)`);
    }
    this.result = next;
    if (changed.size) for (const fn of this.listeners) fn([...changed]);
  }
}

import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SearchHit } from '@cerebro/shared';
import { ConnectorRegistry } from '../connectors/connector-registry.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';
import { LoggingService } from '../logging/logging.service';

/** Serve the index if it's no older than this; otherwise rebuild in the background. */
const FRESH_MS = 30_000;
/** Keep the index warm on this cadence while search is being used. */
const ACTIVE_WINDOW_MS = 5 * 60_000;
/** Cap entries per (instance, kind) so a huge kind (e.g. thousands of HA entities) can't blow up the index. */
const PER_KIND_CAP = 500;

/**
 * A cached, flattened index of every connector's resources, powering the command palette's
 * cross-connector resource search. Building it queries each connector, so results are cached and
 * kept warm by a background refresh while search is in use — a keystroke never fans out live.
 * See docs/command-palette.md (Phase 2).
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly instances: ConnectorInstanceService,
    private readonly logging: LoggingService,
  ) {}

  private index: { at: number; entries: SearchHit[] } | null = null;
  private inflight: Promise<SearchHit[]> | null = null;
  private lastAccess = 0;

  /** Fuzzy-search the cached index. Builds it on the first (cold) call; refreshes stale in background. */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
    this.lastAccess = Date.now();
    let entries = this.index?.entries;
    if (!this.index) {
      entries = await this.refresh(); // cold: must build once
    } else if (Date.now() - this.index.at >= FRESH_MS) {
      void this.refresh().catch(() => { /* keep serving the stale index */ });
    }
    return rank(query, entries ?? [], limit);
  }

  private refresh(): Promise<SearchHit[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.build()
      .then((entries) => { this.index = { at: Date.now(), entries }; return entries; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  @Interval(30_000)
  backgroundRefresh(): void {
    if (Date.now() - this.lastAccess < ACTIVE_WINDOW_MS) void this.refresh().catch(() => { /* keep last good */ });
  }

  /** Walk every enabled connector × its resource kinds into a flat, lightweight entry list. */
  private async build(): Promise<SearchHit[]> {
    const instances = (await this.instances.list()).filter((i) => i.enabled);
    const out: SearchHit[] = [];
    await Promise.all(
      instances.map(async (inst) => {
        const manifest = this.registry.get(inst.connectorId)?.manifest;
        if (!manifest) return;
        await Promise.all(
          manifest.resourceKinds.map(async (k) => {
            let resources;
            try { resources = await this.instances.listResources(inst.id, k.id); } catch { return; }
            for (const r of resources.slice(0, PER_KIND_CAP)) {
              out.push({
                instanceId: inst.id,
                instanceName: inst.name,
                connectorId: inst.connectorId,
                kind: k.id,
                kindLabel: k.label,
                id: r.id,
                name: r.name,
                status: r.status,
              });
            }
          }),
        );
      }),
    );
    void this.logging.debug('search', `Rebuilt resource index: ${out.length} entries across ${instances.length} connector(s).`);
    return out;
  }
}

/** Subsequence fuzzy score (lower = better; null = no match), matched against name/kind/connector. */
function scoreOne(q: string, text: string): number | null {
  if (!q) return 0;
  const t = text.toLowerCase();
  let ti = 0, penalty = 0, last = -1;
  for (let i = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], ti);
    if (at === -1) return null;
    if (last !== -1) penalty += at - last - 1;
    if (i === 0) penalty += at;
    last = at;
    ti = at + 1;
  }
  return penalty;
}

function rank(query: string, entries: SearchHit[], limit: number): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: { e: SearchHit; s: number }[] = [];
  for (const e of entries) {
    // Best score across the name, the "kind · connector" context, and the raw id.
    const s = min3(
      scoreOne(q, e.name),
      scoreOne(q, `${e.kindLabel} ${e.instanceName}`),
      scoreOne(q, e.id),
    );
    if (s !== null) scored.push({ e, s });
  }
  scored.sort((a, b) => a.s - b.s || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, limit).map((x) => x.e);
}

function min3(a: number | null, b: number | null, c: number | null): number | null {
  const vals = [a, b, c].filter((v): v is number => v !== null);
  return vals.length ? Math.min(...vals) : null;
}

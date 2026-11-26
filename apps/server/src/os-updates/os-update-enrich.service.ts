import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import type { OsUpdateCve, OsUpdateDistro, OsUpdatePackage } from '@cerebro/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { KevService, type KevEntry } from '../vuln-intel/kev.service';
import { OsvService, type OsvRecord } from '../vuln-intel/osv.service';
import { CveInfoService, type CveInfo } from '../vuln-intel/cve-info.service';
import { OUTSIDE_IN_KEY } from '../topology/outside-in.service';
import { fixedIds, isNoticeId, osvEcosystem, packagePriority, summarize, type CveScore } from './os-updates.enrich';

/**
 * Works out how much each pending OS update matters (docs/os-updates.md#severity-and-cves):
 * the CVEs it fixes (from the agent for dnf / Windows, from OSV.dev for apt), their
 * scores (CVSS, vendor priority, EPSS) and whether CISA lists them as known exploited.
 * Runs in the background after each report and hourly; the Updates page shows whatever
 * is stored, so a slow or down feed never holds it up. External lookups follow the
 * outside-in toggle (Posture settings); with it off, only what the agent reported and
 * an already-downloaded KEV list are used.
 */
@Injectable()
export class OsUpdateEnrichService {
  private readonly logger = new Logger(OsUpdateEnrichService.name);
  private readonly queue = new Set<string>();
  private running: Promise<void> | null = null;
  /** Called after a machine's priority changes (alerts). */
  onEnriched: ((agentId: string) => Promise<void>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly kev: KevService,
    private readonly osv: OsvService,
    private readonly cveInfo: CveInfoService,
  ) {}

  async lookupsEnabled(): Promise<boolean> {
    return (await this.settings.get<boolean>(OUTSIDE_IN_KEY, true).catch(() => true)) !== false;
  }

  /** Queue a machine; runs one at a time in the background. */
  schedule(agentId: string, retryFailed = false): void {
    if (retryFailed) this.cveInfo.resetBackoff();
    this.queue.add(agentId);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
  }

  /** Resolves when the queue is empty (tests / harness). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.size) {
      const [id] = this.queue;
      this.queue.delete(id);
      try {
        const changed = await this.enrich(id);
        if (changed && this.onEnriched) await this.onEnriched(id);
      } catch (e) {
        this.logger.warn(`CVE detail for ${id}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Hourly: re-score every machine (KEV and EPSS change daily; lookups are cached). */
  @Cron(CronExpression.EVERY_HOUR)
  async refreshAll(): Promise<void> {
    const rows = await this.prisma.agentUpdateStatus.findMany({ where: { checkedAt: { not: null } }, select: { agentId: true } }).catch(() => []);
    for (const r of rows) this.schedule(r.agentId);
  }

  /** Enrich one machine's stored packages. Returns true when its priority / KEV picture changed. */
  async enrich(agentId: string): Promise<boolean> {
    const row = await this.prisma.agentUpdateStatus.findUnique({ where: { agentId } });
    if (!row?.checkedAt) return false;
    const pkgs = (Array.isArray(row.packages) ? (row.packages as unknown as OsUpdatePackage[]) : []).map((p) => ({ ...p }));
    const distro = (row.distro as OsUpdateDistro | null) ?? null;
    const online = await this.lookupsEnabled();
    const notes: string[] = [];

    // 1. apt: what OSV.dev says each update fixes.
    const eco = osvEcosystem(distro, row.manager);
    const records = new Map<string, OsvRecord>();
    const fixedBy = new Map<string, string[]>();
    if (eco && online) {
      const name = (p: OsUpdatePackage) => p.sourcePackage || p.name;
      const pairs = pkgs.filter((p) => p.current && p.available).flatMap((p) => [{ name: name(p), version: p.current! }, { name: name(p), version: p.available! }]);
      const { ids, failed } = await this.osv.affecting(eco, pairs);
      if (failed) notes.push("Couldn't reach OSV.dev, so some CVEs may be missing; Cerebro will try again.");
      for (const p of pkgs) {
        if (!p.current || !p.available) continue;
        const f = fixedIds(ids.get(`${name(p)}@${p.current}`), ids.get(`${name(p)}@${p.available}`));
        if (f.length) fixedBy.set(p.name, f);
      }
      for (const [id, rec] of await this.osv.records([...new Set([...fixedBy.values()].flat())])) records.set(id, rec);
      if (pkgs.some((p) => p.current && !p.sourcePackage)) notes.push('Some packages were matched by binary name; update the agent (0.10+) for exact matches.');
    } else if (row.manager === 'apt' && !online) {
      notes.push('CVE lookups are off (Posture → outside-in checks), so apt updates show security vs regular only.');
    } else if (row.manager === 'apt' && !distro) {
      notes.push('Update the agent (0.10+) so Cerebro can look up the CVEs these updates fix.');
    } else if (row.manager === 'apt') {
      notes.push(`No advisory data for ${distro?.id ?? 'this distro'} ${distro?.versionId ?? ''}`.trim() + '.');
    } else if (['pacman', 'apk', 'softwareupdate'].includes(row.manager ?? '')) {
      notes.push("This package manager doesn't say which CVEs an update fixes.");
    }

    // 2. CVE lists per package: the agent's own plus what OSV adds.
    const known = new Map<string, { cvss: number | null; cvssVector: string | null; priority: string | null; summary: string | null }>();
    for (const p of pkgs) {
      const f = fixedBy.get(p.name) ?? [];
      const cves = new Set(p.cves ?? []);
      const adv = new Set(p.advisories ?? []);
      for (const id of f) {
        const rec = records.get(id);
        for (const c of rec?.cves ?? []) cves.add(c);
        if (isNoticeId(id)) adv.add(id);
        // A per-CVE record (UBUNTU-CVE-…) carries that CVE's own score.
        const own = /^(?:UBUNTU|DEBIAN)-(CVE-\d{4}-\d{4,})$/.exec(id)?.[1];
        if (own && rec && !rec.missing && (rec.cvss != null || rec.priority)) known.set(own, { cvss: rec.cvss, cvssVector: rec.cvssVector, priority: rec.priority, summary: rec.summary });
      }
      if (cves.size) p.cves = [...cves].sort().slice(0, 60); else delete p.cves;
      if (adv.size) p.advisories = [...adv].slice(0, 20); else delete p.advisories;
    }

    // 3. Scores and KEV.
    const allCves = [...new Set(pkgs.flatMap((p) => p.cves ?? []))];
    const kev = online ? ((await this.kev.get()) ?? this.kev.peek()) : this.kev.peek();
    if (online && !kev && allCves.length) notes.push("Couldn't download CISA's known-exploited list; Cerebro will try again.");
    const info = online ? await this.cveInfo.ensure(allCves, known, true) : await this.cveInfo.cached(allCves);
    const scores = new Map<string, CveScore>(allCves.map((c) => {
      const i = info.get(c);
      const k = known.get(c);
      return [c, { cvss: i?.cvss ?? k?.cvss ?? null, priority: i?.priority ?? k?.priority ?? null, epss: i?.epss ?? null }];
    }));

    // 4. Priority per package and for the machine.
    for (const p of pkgs) {
      delete p.priority; delete p.maxCvss; delete p.kev; delete p.epss;
      Object.assign(p, packagePriority(p, scores, kev));
    }
    const sum = summarize(pkgs, kev);
    const now = new Date();
    const patchNowSince = sum.priority === 'patch-now' ? (row.priority === 'patch-now' && row.patchNowSince ? row.patchNowSince : now) : null;
    // Only write if no newer report replaced the packages meanwhile; that report queues another run.
    const res = await this.prisma.agentUpdateStatus.updateMany({
      where: { agentId, checkedAt: row.checkedAt },
      data: {
        packages: pkgs as unknown as Prisma.InputJsonValue,
        priority: sum.priority,
        cveCount: sum.cveCount,
        kevCount: sum.kevCount,
        kevCves: sum.kevCves,
        patchNowSince,
        enrichedAt: now,
        enrichNote: notes.join(' ') || null,
      },
    });
    if (!res.count) return false;
    return row.priority !== sum.priority || row.kevCount !== sum.kevCount;
  }

  /** CVE details for the machine view, from caches only. */
  async cveDetails(cves: string[]): Promise<Record<string, OsUpdateCve>> {
    const uniq = [...new Set(cves)];
    const info: Map<string, CveInfo> = await this.cveInfo.cached(uniq).catch(() => new Map());
    const kev: Map<string, KevEntry> | null = this.kev.peek();
    const out: Record<string, OsUpdateCve> = {};
    for (const id of uniq) {
      const i = info.get(id);
      const k = kev?.get(id);
      out[id] = {
        id,
        cvss: i?.cvss ?? null,
        priority: i?.priority ?? null,
        summary: i?.summary ?? null,
        epss: i?.epss ?? null,
        epssPercentile: i?.epssPercentile ?? null,
        kev: k ? { dateAdded: k.dateAdded ?? null, dueDate: k.dueDate ?? null, name: k.vulnerabilityName ?? null, ransomware: (k.knownRansomwareCampaignUse ?? '').trim().toLowerCase() === 'known' } : null,
      };
    }
    return out;
  }
}

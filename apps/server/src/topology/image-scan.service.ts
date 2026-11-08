import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageScanSummary } from '@cerebro/shared';
import { SettingsService } from '../settings/settings.service';
import { LoggingService } from '../logging/logging.service';
import { ConnectorInstanceService } from '../connectors/connector-instance.service';

/**
 * CVE scan of the container images that are running, with Trivy (bundled in the Cerebro
 * image). Scans by "repo@sha256:…" digest straight from the registry, so it checks the exact
 * image each container runs without touching the Docker hosts. Locally built images have no
 * registry digest and are skipped. Runs once a day (and on demand); results are kept in
 * settings so a restart doesn't lose them. See docs/architecture-map.md#posture-findings.
 */

export const IMAGE_SCAN_ENABLED_KEY = 'posture.imageScan.enabled';
const RESULTS_KEY = 'posture.imageScan.results';
/** Rescan an unchanged digest after this long (the CVE database moves even when the image doesn't). */
const RESCAN_MS = 24 * 3600_000;
const SCAN_TIMEOUT_MS = 5 * 60_000;
/** Keep this many CVEs per image (worst first); counts are always complete. */
const KEEP_VULNS = 40;

export interface ImageVuln {
  id: string;
  pkg: string;
  installed: string;
  fixed?: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  title?: string;
}

export interface ImageScanResult {
  ref: string;
  scannedAt: string;
  counts: { critical: number; high: number; medium: number; low: number; fixable: number };
  vulns: ImageVuln[];
  /** Every CVE id found (any severity), for the CISA KEV cross-check. */
  ids: string[];
  error?: string;
}

interface Stored {
  lastRunAt?: string;
  results: Record<string, ImageScanResult>;
}

const SEV_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

@Injectable()
export class ImageScanService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logging: LoggingService,
    private readonly instances: ConnectorInstanceService,
  ) {}

  private running: Promise<void> | null = null;
  private progress: { done: number; total: number } | null = null;
  private trivyMissing = false;

  async enabled(): Promise<boolean> {
    return (await this.settings.get<boolean>(IMAGE_SCAN_ENABLED_KEY, true)) !== false;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.settings.set(IMAGE_SCAN_ENABLED_KEY, on);
  }

  /** Stored results, keyed by "repo@sha256:…". */
  async results(): Promise<Record<string, ImageScanResult>> {
    return ((await this.settings.get<Stored>(RESULTS_KEY)) ?? { results: {} }).results ?? {};
  }

  async summary(): Promise<ImageScanSummary> {
    const stored = (await this.settings.get<Stored>(RESULTS_KEY)) ?? { results: {} };
    const rs = Object.values(stored.results ?? {});
    return {
      enabled: await this.enabled(),
      available: !this.trivyMissing,
      running: !!this.running,
      progress: this.progress ?? undefined,
      lastRunAt: stored.lastRunAt,
      scanned: rs.filter((r) => !r.error).length,
      failed: rs.filter((r) => r.error).length,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightly(): Promise<void> {
    if (await this.enabled()) void this.scanAll(false).catch(() => undefined);
  }

  /** Scan every running registry image; `force` rescans digests scanned within the last day too. */
  scanAll(force: boolean): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doScan(force).finally(() => {
      this.running = null;
      this.progress = null;
    });
    return this.running;
  }

  /** "repo@sha256:…" of every running container, across Docker connectors. Locally built images have none. */
  async runningImages(): Promise<{ refs: string[]; local: number }> {
    const refs = new Set<string>();
    let local = 0;
    for (const i of (await this.instances.list()).filter((x) => x.enabled && x.connectorId === 'docker')) {
      try {
        const cs = (await this.instances.listResourcesCached(i.id, 'container', {})).resources;
        for (const c of cs) {
          if (c.status !== 'running' && c.details?.state !== 'running') continue;
          const rd = typeof c.details?.repo_digest === 'string' ? c.details.repo_digest : null;
          if (rd) refs.add(rd);
          else local++;
        }
      } catch {
        /* a host that's down is scanned next time */
      }
    }
    return { refs: [...refs].sort(), local };
  }

  private async doScan(force: boolean): Promise<void> {
    const cacheDir = this.cacheDir();
    const { refs } = await this.runningImages();
    const stored = (await this.settings.get<Stored>(RESULTS_KEY)) ?? { results: {} };
    const results: Record<string, ImageScanResult> = {};
    const now = Date.now();
    const todo = refs.filter((r) => force || !stored.results?.[r] || stored.results[r].error || now - new Date(stored.results[r].scannedAt).getTime() > RESCAN_MS);
    for (const r of refs) if (!todo.includes(r) && stored.results?.[r]) results[r] = stored.results[r];
    this.progress = { done: 0, total: todo.length };

    if (todo.length) {
      try {
        // One database download per run; each image scan then skips it.
        await this.trivy(['image', '--download-db-only', '--cache-dir', cacheDir, '--quiet'], cacheDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.trivyMissing = /ENOENT/.test(msg);
        void this.logging.warn('topology', `Image CVE scan: ${this.trivyMissing ? 'Trivy is not installed in this Cerebro image' : `vulnerability database download failed: ${msg}`}`);
        return;
      }
    }

    for (const ref of todo) {
      try {
        const out = await this.trivy(
          ['image', '--image-src', 'remote', '--scanners', 'vuln', '--format', 'json', '--quiet', '--skip-db-update', '--cache-dir', cacheDir, '--timeout', '4m', ref],
          cacheDir,
        );
        results[ref] = parseTrivy(ref, out);
      } catch (err) {
        results[ref] = { ref, scannedAt: new Date().toISOString(), counts: { critical: 0, high: 0, medium: 0, low: 0, fixable: 0 }, vulns: [], ids: [], error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
      }
      this.progress = { done: (this.progress?.done ?? 0) + 1, total: todo.length };
      // Save as we go, so a long run shows partial results and survives a restart.
      await this.settings.set(RESULTS_KEY, { lastRunAt: stored.lastRunAt, results: { ...stored.results, ...results } } satisfies Stored);
    }
    // Drop digests nothing runs any more.
    await this.settings.set(RESULTS_KEY, { lastRunAt: new Date().toISOString(), results } satisfies Stored);
    const failed = Object.values(results).filter((r) => r.error).length;
    void this.logging.info('topology', `Image CVE scan: ${todo.length} image(s) scanned${failed ? `, ${failed} failed` : ''}`);
  }

  private cacheDir(): string {
    for (const d of [process.env.TRIVY_CACHE_DIR, '/data/trivy', join(tmpdir(), 'cerebro-trivy')]) {
      if (!d) continue;
      try {
        mkdirSync(d, { recursive: true });
        return d;
      } catch {
        /* try the next one */
      }
    }
    return join(tmpdir(), 'cerebro-trivy');
  }

  private trivy(args: string[], cacheDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        process.env.TRIVY_BIN || 'trivy',
        args,
        { timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TRIVY_CACHE_DIR: cacheDir, TRIVY_NO_PROGRESS: 'true' } },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            reject(new Error(code === 'ENOENT' ? 'ENOENT: trivy not found' : (stderr || err.message).trim().split('\n').slice(-3).join(' ')));
          } else resolve(stdout);
        },
      );
    });
  }
}

/** Trivy JSON → counts + the worst CVEs (deduped by CVE + package). */
export function parseTrivy(ref: string, json: string): ImageScanResult {
  const j = JSON.parse(json || '{}') as { Results?: { Vulnerabilities?: { VulnerabilityID?: string; PkgName?: string; InstalledVersion?: string; FixedVersion?: string; Severity?: string; Title?: string }[] }[] };
  const seen = new Map<string, ImageVuln>();
  for (const r of j.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      if (!v.VulnerabilityID) continue;
      const key = `${v.VulnerabilityID}|${v.PkgName}`;
      if (seen.has(key)) continue;
      const sev = (String(v.Severity ?? 'UNKNOWN').toUpperCase() as ImageVuln['severity']) in SEV_ORDER ? (String(v.Severity).toUpperCase() as ImageVuln['severity']) : 'UNKNOWN';
      seen.set(key, { id: v.VulnerabilityID, pkg: v.PkgName ?? '?', installed: v.InstalledVersion ?? '?', fixed: v.FixedVersion || undefined, severity: sev, title: v.Title?.slice(0, 160) });
    }
  }
  const all = [...seen.values()];
  const count = (s: string) => all.filter((v) => v.severity === s).length;
  return {
    ref,
    scannedAt: new Date().toISOString(),
    counts: { critical: count('CRITICAL'), high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'), fixable: all.filter((v) => v.fixed).length },
    // Detail for the worst ones (fixable first); `ids` keeps every CVE for the KEV check.
    vulns: all
      .filter((v) => v.severity === 'CRITICAL' || v.severity === 'HIGH')
      .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || Number(!a.fixed) - Number(!b.fixed) || a.id.localeCompare(b.id))
      .slice(0, KEEP_VULNS),
    ids: [...new Set(all.map((v) => v.id))].sort(),
  };
}

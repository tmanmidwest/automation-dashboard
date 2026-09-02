import type { MonitorProbeManifest } from '@cerebro/shared';

/** TLS certificate facts captured by HTTPS probes. */
export interface ProbeCert {
  validTo: string;
  daysLeft: number;
  issuer?: string;
  subject?: string;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  /** Short human-readable outcome ("200 OK in 42 ms", "ECONNREFUSED", …). */
  message: string;
  cert?: ProbeCert;
}

export type ProbeConfig = Record<string, unknown>;

/**
 * A pluggable check type. Each probe declares its config fields (rendered
 * generically by the monitor form) and knows how to run one check. Probes must
 * honour `timeoutMs` and never throw — return `{ ok: false, message }` instead.
 */
export interface Probe {
  readonly manifest: MonitorProbeManifest;
  /** Short display string for the list view, e.g. "https://x" or "host:22". */
  describeTarget(config: ProbeConfig): string;
  /** Return an error message for an invalid config, or null when it is fine. */
  validate(config: ProbeConfig): string | null;
  run(config: ProbeConfig, timeoutMs: number): Promise<ProbeResult>;
}

export function str(config: ProbeConfig, key: string): string {
  const v = config[key];
  return v === undefined || v === null ? '' : String(v).trim();
}

export function num(config: ProbeConfig, key: string, fallback: number): number {
  const v = Number(config[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function bool(config: ProbeConfig, key: string): boolean {
  return config[key] === true || config[key] === 'true';
}

export function errMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    const e = err as { code: string; message?: string };
    return e.code === 'ABORT_ERR' ? 'Timed out' : e.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Race a probe against a hard deadline so a misbehaving check can never hang the scheduler. */
export function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]);
}

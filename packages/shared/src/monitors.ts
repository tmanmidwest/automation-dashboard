/**
 * Uptime monitoring (the Uptime-Kuma replacement).
 *
 * A Monitor is one probed target (a host to ping, a URL to fetch, a TCP port,
 * a DNS name). Probe *types* are pluggable server-side and each publishes a
 * manifest of config fields, so the add/edit form renders generically — the
 * same way connector setup does. Every check writes a heartbeat; transitions
 * raise alerts through the notifications catalog.
 */
import type { ConnectorConfigField } from './connector';

export type MonitorStatus = 'up' | 'down' | 'pending' | 'paused';

/** Declarative description of a probe type (ping, http, …). */
export interface MonitorProbeManifest {
  /** Stable id, e.g. 'http'. */
  id: string;
  label: string;
  description: string;
  /** Lucide icon key for the UI. */
  icon?: string;
  /** Type-specific config fields rendered on the monitor form. */
  fields: ConnectorConfigField[];
}

/** One check outcome. */
export interface MonitorHeartbeat {
  status: MonitorStatus;
  latencyMs: number | null;
  message: string | null;
  /** True when this beat changed the monitor's status (an "event"). */
  important: boolean;
  at: string;
}

/** Fields shared by list rows and the detail view. */
export interface MonitorSummary {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  /** Human-readable target derived from config, e.g. "https://example.com" or "10.0.0.5:22". */
  target: string;
  enabled: boolean;
  intervalSec: number;
  tags: string[];
  status: MonitorStatus;
  /** When the status last flipped (up→down etc.), for "down since". */
  lastChangeAt: string | null;
  lastCheckAt: string | null;
  lastLatencyMs: number | null;
  lastMessage: string | null;
  /** TLS certificate expiry (HTTPS monitors only). */
  certExpiresAt: string | null;
  certDaysLeft: number | null;
  /** Fraction 0–1 over the trailing window; null when there is no data yet. */
  uptime24h: number | null;
  uptime30d: number | null;
  avgLatency24hMs: number | null;
  /** Most recent beats, oldest → newest, for the heartbeat bar. */
  recentBeats: MonitorHeartbeat[];
}

export interface MonitorDetail extends MonitorSummary {
  config: Record<string, unknown>;
  retries: number;
  retryIntervalSec: number;
  timeoutSec: number;
  resendEveryN: number;
  upsideDown: boolean;
  description: string | null;
  createdAt: string;
}

/** Create / update payload. */
export interface MonitorInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  intervalSec: number;
  retries: number;
  retryIntervalSec: number;
  timeoutSec: number;
  resendEveryN: number;
  upsideDown: boolean;
  description?: string;
  tags?: string[];
}

export type MonitorChartRange = '1h' | '24h' | '7d' | '30d';

/** A (possibly bucketed) point on the response-time chart. */
export interface MonitorChartPoint {
  at: string;
  /** Average latency in the bucket; null when every beat in it failed. */
  latencyMs: number | null;
  /** Bucket status: 'down' if any beat was down, else 'pending' if any pending, else 'up'. */
  status: MonitorStatus;
}

export interface MonitorChart {
  range: MonitorChartRange;
  points: MonitorChartPoint[];
}

/** Result of a Kuma backup import. */
export interface MonitorImportResult {
  imported: number;
  skipped: { name: string; reason: string }[];
}

/** Overall counts for the list header / dashboard. */
export interface MonitorStats {
  total: number;
  up: number;
  down: number;
  pending: number;
  paused: number;
}

/** Kuma's minimum; we match it. */
export const MONITOR_MIN_INTERVAL_SEC = 20;

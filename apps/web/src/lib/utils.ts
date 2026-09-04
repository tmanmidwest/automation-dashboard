import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Resource status badge colors ──────────────────────────────
// Shared across the connector detail table and the resources overview so a status
// looks the same everywhere. Covers connector lifecycle states (Proxmox/AWS) and
// Home Assistant entity states (on/off/unavailable/locked/heat/…).
const STATUS_BAD = new Set(['unavailable', 'unknown', 'error', 'failed', 'fault', 'offline', 'unhealthy', 'disconnected']);
const STATUS_GOOD = new Set([
  'running', 'active', 'enabled', 'on', 'online', 'available', 'connected', 'ok',
  'home', 'playing', 'locked', 'heat', 'cool', 'heat_cool', 'auto',
]);
const STATUS_IDLE = new Set([
  'stopped', 'disabled', 'off', 'idle', 'standby', 'paused', 'closed',
  'not_home', 'away', 'docked', 'unlocked',
]);

/** Tailwind classes for a resource status badge, by status string. */
export function statusBadgeColor(status?: string): string {
  const s = (status ?? '').toLowerCase();
  if (STATUS_BAD.has(s)) return 'text-red-400 bg-red-500/15';
  if (STATUS_GOOD.has(s)) return 'text-emerald-400 bg-emerald-500/15';
  if (STATUS_IDLE.has(s)) return 'text-muted-foreground bg-muted';
  // Numeric readings (e.g. a sensor's value) aren't good/bad — show them as neutral info.
  if (s !== '' && !Number.isNaN(Number(s))) return 'text-sky-400 bg-sky-500/15';
  // Transitional / unrecognized states.
  return 'text-amber-400 bg-amber-500/15';
}

/** Format an amount as currency, e.g. formatMoney(1234.5, "USD") → "$1,234.50". Falls back gracefully for odd codes. */
export function formatMoney(value: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Compact date + time, e.g. "Aug 30, 10:14". Empty string for null/invalid. */
export function shortDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Compact relative time, e.g. "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

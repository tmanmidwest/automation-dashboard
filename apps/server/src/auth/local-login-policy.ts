import { BlockList, isIP } from 'node:net';
import type { LocalLoginPolicy } from '@cerebro/shared';

/**
 * Pure helpers for the local (password) sign-in IP policy. Kept free of Nest so the
 * break-glass CLI (src/cli.ts) can share the exact same parsing and storage key.
 */

/** Setting-table key the policy is stored under. */
export const LOCAL_LOGIN_SETTING_KEY = 'auth.localLogin';

export const DEFAULT_LOCAL_LOGIN_POLICY: LocalLoginPolicy = { enabled: true, allowedCidrs: [] };

/** Shown in the UI and errors so the escape hatch is visible before it's needed. */
export const BREAK_GLASS_COMMAND = 'docker compose exec app cerebro-admin local-login allow-all';

/** `::ffff:192.168.1.5` → `192.168.1.5`, so IPv4 rules match dual-stack sockets. */
export function normalizeIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  return isIP(v) ? v : null;
}

/**
 * Parse one entry: a bare address (treated as /32 or /128) or `addr/prefix`.
 * Returns the canonical `addr/prefix` string, or throws with a readable message.
 */
export function parseCidr(entry: string): { address: string; prefix: number; family: 'ipv4' | 'ipv6'; text: string } {
  const raw = entry.trim();
  const [addrPart, prefixPart, extra] = raw.split('/');
  const address = normalizeIp(addrPart);
  if (!address || extra !== undefined) throw new Error(`"${raw}" is not an IP address or CIDR range.`);
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  const prefix = prefixPart === undefined ? max : Number(prefixPart);
  if (!/^\d+$/.test(prefixPart ?? String(max)) || prefix < 0 || prefix > max) {
    throw new Error(`"${raw}" has an invalid prefix length (0–${max}).`);
  }
  return { address, prefix, family, text: `${address}/${prefix}` };
}

/** Validate + canonicalize + de-duplicate a list of entries (throws on the first bad one). */
export function normalizeCidrs(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!e.trim()) continue;
    const { text } = parseCidr(e);
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** Coerce whatever is stored in the Setting row into a well-formed policy. */
export function coercePolicy(value: unknown): LocalLoginPolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_LOCAL_LOGIN_POLICY };
  const v = value as Partial<LocalLoginPolicy>;
  const cidrs = Array.isArray(v.allowedCidrs) ? v.allowedCidrs.filter((c): c is string => typeof c === 'string') : [];
  // A corrupt entry is dropped rather than failing open or closed for the whole list.
  const valid = cidrs.filter((c) => {
    try {
      parseCidr(c);
      return true;
    } catch {
      return false;
    }
  });
  return { enabled: v.enabled !== false, allowedCidrs: valid };
}

/** Whether `ip` may use password sign-in under `policy`. Unknown IP + a non-empty list → no. */
export function isIpAllowed(policy: LocalLoginPolicy, ip: string | undefined | null): boolean {
  if (!policy.enabled) return false;
  if (policy.allowedCidrs.length === 0) return true;
  const addr = normalizeIp(ip);
  if (!addr) return false;
  const list = new BlockList();
  for (const c of policy.allowedCidrs) {
    const { address, prefix, family } = parseCidr(c);
    list.addSubnet(address, prefix, family);
  }
  return list.check(addr, isIP(addr) === 4 ? 'ipv4' : 'ipv6');
}

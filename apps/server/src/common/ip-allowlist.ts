import { BlockList, isIP } from 'node:net';

/**
 * Source-address allowlists: entries are single addresses or CIDR ranges, IPv4 or IPv6.
 * An empty list allows everything.
 */

/** Validate and normalize allowlist entries; throws an Error naming the first bad entry. */
export function cleanIpAllowlist(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new Error('The IP allowlist must be a list.');
  const out: string[] = [];
  for (const raw of entries) {
    const entry = String(raw ?? '').trim();
    if (!entry) continue;
    if (entry.length > 64) throw new Error(`"${entry.slice(0, 64)}…" is not an IP address or CIDR range.`);
    const [addr, bits, extra] = entry.split('/');
    const family = isIP(addr);
    const max = family === 4 ? 32 : 128;
    const okBits = bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= max);
    if (!family || extra !== undefined || !okBits) throw new Error(`"${entry}" is not an IP address or CIDR range.`);
    out.push(entry);
  }
  if (out.length > 100) throw new Error('At most 100 IP allowlist entries.');
  return [...new Set(out)];
}

/** True when `ip` is allowed by `entries` (empty list = allowed). */
export function ipAllowed(entries: string[], ip: string | undefined): boolean {
  if (!entries.length) return true;
  if (!ip) return false;
  // Express reports IPv4 clients on a dual-stack socket as ::ffff:a.b.c.d.
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const entry of entries) {
    const [a, bits] = entry.split('/');
    const f = isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(a, f);
    else list.addSubnet(a, Number(bits), f);
  }
  return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

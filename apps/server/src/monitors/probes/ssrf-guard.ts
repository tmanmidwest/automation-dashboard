import { BlockList, isIPv4, isIPv6, type LookupFunction } from 'net';
import { lookup as dnsLookup } from 'dns';

/**
 * SSRF guard for user-created monitor probes. Cerebro monitors internal hosts by
 * design (it's a homelab uptime checker), so RFC1918 / IPv6-ULA private ranges are
 * intentionally ALLOWED. What's blocked by default is the genuinely dangerous set:
 *  - loopback (127.0.0.0/8, ::1) — localhost-only admin/proxy services, and
 *  - link-local (169.254.0.0/16, fe80::/10) — cloud metadata (169.254.169.254),
 *  - the unspecified/"this host" ranges.
 *
 * Set MONITOR_ALLOW_LOCAL_TARGETS=true to lift the block (advanced/self-host use).
 */
let cached: BlockList | null = null;
function blockList(): BlockList {
  if (cached) return cached;
  const bl = new BlockList();
  bl.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
  bl.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. cloud metadata 169.254.169.254
  bl.addSubnet('0.0.0.0', 8, 'ipv4'); // "this host" / unspecified
  bl.addAddress('::1', 'ipv6'); // loopback
  bl.addAddress('::', 'ipv6'); // unspecified
  bl.addSubnet('fe80::', 10, 'ipv6'); // link-local
  // IPv4-mapped IPv6 equivalents of the blocked v4 ranges, so the hex form
  // (e.g. ::ffff:7f00:1 = 127.0.0.1, ::ffff:a9fe:a9fe = 169.254.169.254) — which
  // `normalize()` can't fold back to dotted — is caught by the IPv6 check. Mapped
  // RFC1918 stays allowed (not in these subnets).
  bl.addSubnet('::ffff:127.0.0.0', 104, 'ipv6'); // loopback
  bl.addSubnet('::ffff:169.254.0.0', 112, 'ipv6'); // link-local incl. metadata
  bl.addSubnet('::ffff:0.0.0.0', 104, 'ipv6'); // "this host" / unspecified
  cached = bl;
  return bl;
}

export function allowLocalTargets(): boolean {
  const v = (process.env.MONITOR_ALLOW_LOCAL_TARGETS ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Normalize an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to plain IPv4. */
function normalize(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/** True if `ip` is loopback / link-local / unspecified (SSRF-sensitive). */
export function isBlockedAddress(ip: string): boolean {
  const a = normalize(ip);
  if (isIPv4(a)) return blockList().check(a, 'ipv4');
  if (isIPv6(a)) return blockList().check(a, 'ipv6');
  return false;
}

/**
 * If `host` is a **literal IP** in a blocked range, return a human message; else
 * null. Hostnames return null here — they are guarded at resolution time by
 * {@link guardedLookup} (net/http skip the custom lookup for literal IPs, so both
 * checks are needed). Callers should run this for the initial target and every
 * redirect hop.
 */
export function hostBlockedReason(host: string): string | null {
  if (allowLocalTargets()) return null;
  const h = host.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if ((isIPv4(h) || isIPv6(h)) && isBlockedAddress(h)) {
    return `Blocked target ${h} (loopback/link-local/metadata). Set MONITOR_ALLOW_LOCAL_TARGETS=true to allow.`;
  }
  return null;
}

/**
 * A `dns.lookup` drop-in for the net/http `lookup` option that refuses to resolve
 * to a blocked address. Because the socket connects to exactly the address this
 * returns, it also defeats DNS-rebinding (a name that flips public→private between
 * checks) and covers every redirect hop. RFC1918 private ranges pass through.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  if (allowLocalTargets()) {
    dnsLookup(hostname, options, callback);
    return;
  }
  dnsLookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address as string, family);
    const list = Array.isArray(address) ? address : [{ address: address as string, family: family as number }];
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        const e = Object.assign(new Error(`Blocked target ${a.address} (loopback/link-local/metadata).`), { code: 'EBLOCKED' });
        return callback(e, address as string, family);
      }
    }
    callback(null, address as string, family);
  });
};

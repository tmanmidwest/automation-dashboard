import type { ConnectorResource, PostureFinding, PostureSeverity, TopologyGraph, TopoNode } from '@cerebro/shared';
import type { BuildInput } from './topology.builder';

/**
 * Security posture findings: things worth fixing, worked out only from what the
 * connectors already report (no outside lookups). Pure, so it is tested against
 * copies of live data. Grouped findings keep one stable id per check + source, so a
 * snooze survives rebuilds; see `isSnoozed` for how a snooze lapses early.
 */

const SEV_RANK: Record<PostureSeverity, number> = { high: 3, medium: 2, low: 1 };
const DAY = 86_400_000;
/** A Proxmox backup older than this counts as stale. */
export const BACKUP_STALE_DAYS = 14;
/** A valid certificate expiring within this many days is flagged. */
export const CERT_SOON_DAYS = 14;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isIp = (s: string | null | undefined): s is string => !!s && /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** "2026-11-01 00:53:15" / "2026-11-01" → Date (local wall time read as UTC; day precision is plenty). */
function parseDay(v: unknown): Date | null {
  const s = str(v);
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s) : null;
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
}

const ipInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
/** Is `ip` inside the network node id "net:192.168.10.0/24"? */
function inNet(ip: string, netId: string): boolean {
  const m = /^net:(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(netId);
  if (!m || !isIp(ip)) return false;
  const size = 2 ** (32 - Number(m[2]));
  return Math.floor(ipInt(ip) / size) === Math.floor(ipInt(m[1]) / size);
}

/** vzdump-qemu-44108-2026_11_01-00_53_15.vma.zst → { vmid: "44108", kind: "qemu", at } */
function parseDump(f: ConnectorResource): { vmid: string; at: Date | null } | null {
  const m = /^vzdump-(qemu|lxc)-(\d+)-(\d{4})_(\d{2})_(\d{2})-(\d{2})_(\d{2})_(\d{2})/.exec(f.id || f.name);
  if (!m) return null;
  const at = parseDay(f.details?.taken) ?? new Date(Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7], +m[8]));
  return { vmid: m[2], at };
}

export function buildFindings(input: BuildInput, graph: TopologyGraph, now: Date = new Date()): PostureFinding[] {
  const out: PostureFinding[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeByIp = new Map<string, TopoNode>();
  for (const n of graph.nodes) for (const ip of n.ips) if (!nodeByIp.has(ip)) nodeByIp.set(ip, n);
  const sourceNode = (connectorId: string, instanceId: string, resourceId: string) =>
    graph.nodes.find((n) => n.sources.some((s) => s.connectorId === connectorId && s.instanceId === instanceId && s.resourceId === resourceId));
  const fmtDay = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (d: Date) => Math.floor((now.getTime() - d.getTime()) / DAY);

  const gearIps = graph.nodes.filter((n) => n.type === 'switch' || n.type === 'ap').flatMap((n) => n.ips);

  // Port forwards that reach Nginx Proxy Manager, by NPM instance.
  const wanForwards = input.unifi.flatMap((u) =>
    u.portForwards
      .filter((pf) => String(pf.status ?? '').toLowerCase() !== 'disabled')
      .map((pf) => {
        const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?/.exec(str(pf.details?.forwardTo) ?? '');
        return { u, pf, ip: m?.[1] ?? null, toPort: m?.[2] ?? null, wanPort: str(pf.details?.port), from: str(pf.details?.from) ?? 'any', iface: str(pf.details?.interface) };
      }),
  );
  const npmIps = new Set<string>();
  for (const n of input.npm) {
    if (isIp(n.baseHost)) npmIps.add(n.baseHost);
    // The host behind the "served by NPM" links, if NPM is configured by name.
    for (const e of graph.edges) if (e.type === 'resolves' && e.label === 'served by NPM') for (const ip of byId.get(e.target)?.ips ?? []) npmIps.add(ip);
  }

  // 1. NPM proxy hosts with SSL off.
  for (const n of input.npm) {
    const http = n.proxyHosts.filter((p) => String(p.details?.enabled ?? 'Yes') !== 'No' && /^off$/i.test(str(p.details?.ssl) ?? ''));
    if (!http.length) continue;
    const npmIp = isIp(n.baseHost) ? n.baseHost : null;
    const port80 = wanForwards.find((f) => f.wanPort === '80' && f.ip && (f.ip === npmIp || (!npmIp && npmIps.has(f.ip))));
    const withAuth = http.filter((p) => { const a = str(p.details?.access_list); return !!a && !/^public$/i.test(a); });
    out.push({
      id: `npm-http:${n.inst.id}`,
      severity: port80 ? 'high' : 'medium',
      category: 'encryption',
      title: `${plural(http.length, 'proxy host')} served over plain HTTP`,
      why:
        (port80
          ? `WAN port 80 is forwarded to this proxy ("${port80.pf.name}"), so these are reachable from the internet without encryption. `
          : 'Traffic to these names is unencrypted on the network. ') +
        (withAuth.length
          ? `${plural(withAuth.length, 'of them is', 'of them are')} behind an access list; if that list asks for a username and password, those travel in clear text too.`
          : 'Anyone on the path can read or change what is sent.'),
      fix: 'In Nginx Proxy Manager, request a Let\'s Encrypt certificate for each host and turn on "Force SSL".',
      affected: http.map((p) => ({ label: p.name, nodeId: byId.has(`dns:${p.name.toLowerCase()}`) ? `dns:${p.name.toLowerCase()}` : undefined, note: [str(p.details?.forward), withAuth.includes(p) ? `access list ${str(p.details?.access_list)}` : null].filter(Boolean).join(' · ') })),
      alsoOn: port80?.ip ? [nodeByIp.get(port80.ip)?.id].filter((x): x is string => !!x) : undefined,
      source: n.inst.name,
    });
  }

  // 2. Port forwards from anywhere that skip the reverse proxy.
  for (const f of wanForwards) {
    if (!f.ip || f.from.toLowerCase() !== 'any') continue;
    if (npmIps.has(f.ip) && (f.wanPort === '80' || f.wanPort === '443')) continue; // the proxy's own way in
    const target = nodeByIp.get(f.ip);
    const net = target?.parent ? byId.get(target.parent) : undefined;
    // "Management" network: the one the switches / access points have their addresses on.
    const mgmt = !!net && net.type === 'network' && gearIps.some((ip) => inNet(ip, net.id));
    out.push({
      id: `pf-open:${f.u.inst.id}:${f.pf.id}`,
      severity: mgmt ? 'high' : 'medium',
      category: 'exposure',
      title: `Port forward "${f.pf.name}" is open to the whole internet`,
      why:
        `WAN port ${f.wanPort ?? '?'} goes straight to ${f.ip}:${f.toPort ?? f.wanPort ?? '?'} from any source, past the reverse proxy.` +
        (mgmt ? ` That machine sits on ${net!.label}, the network your switches and access points are managed on, so a compromise lands next to your network gear.` : '') +
        (f.iface === 'all' ? ' It listens on every WAN interface.' : ''),
      fix: mgmt
        ? 'Move the service to the DMZ VLAN, or limit the forward to known source addresses. If it is only for remote streaming, publish it through the proxy or a tunnel instead.'
        : 'Limit the forward to known source addresses, or publish the service through the reverse proxy or a tunnel instead.',
      affected: [{ label: target?.label && target.label !== f.ip ? `${target.label} (${f.ip})` : f.ip, nodeId: target?.id, note: `WAN :${f.wanPort} → :${f.toPort ?? '?'}` }],
      alsoOn: ['internet'],
      source: f.u.inst.name,
    });
  }

  // 3. Proxmox backups: running guests never backed up, or not for a while; dumps of guests that are gone.
  const dumps = (input.backups ?? []).flatMap((b) => b.files.map((f) => ({ b, f, d: parseDump(f) }))).filter((x) => x.d);
  if (input.backups?.length) {
    const latest = new Map<string, { at: Date | null; inB2: boolean }>();
    for (const { f, d } of dumps) {
      const prev = latest.get(d!.vmid);
      if (!prev || (d!.at && (!prev.at || d!.at > prev.at))) latest.set(d!.vmid, { at: d!.at, inB2: !/^no/i.test(str(f.details?.inB2) ?? '') });
    }
    const srcName = input.backups.map((b) => b.inst.name).join(', ');
    for (const p of input.proxmox) {
      const running = p.guests.filter((g) => g.status === 'running');
      const never = running.filter((g) => !latest.has(g.id));
      const stale = running.filter((g) => { const at = latest.get(g.id)?.at; return !!at && daysAgo(at) > BACKUP_STALE_DAYS; });
      const label = (g: ConnectorResource) => `${g.name} (${g.kind === 'lxc' ? 'CT' : 'VM'} ${g.id})`;
      if (never.length)
        out.push({
          id: `backup-missing:${p.inst.id}`,
          severity: 'medium',
          category: 'backups',
          title: `${plural(never.length, 'running guest has', 'running guests have')} no backup`,
          why: 'No vzdump backup for these was found in the backup folder, so a failed disk or a bad change has nothing to roll back to.',
          fix: 'Add them to the Proxmox backup job (Datacenter → Backup), or exclude them on purpose and snooze this.',
          affected: never.map((g) => ({ label: label(g), nodeId: sourceNode('proxmox', p.inst.id, g.id)?.id })),
          source: `${p.inst.name} + ${srcName}`,
        });
      if (stale.length)
        out.push({
          id: `backup-stale:${p.inst.id}`,
          severity: 'medium',
          category: 'backups',
          title: `${plural(stale.length, 'guest’s', 'guests’')} last backup is over ${BACKUP_STALE_DAYS} days old`,
          why: 'The others were backed up recently, so these probably dropped out of the backup job or keep failing.',
          fix: 'Check the Proxmox task log for failed vzdump runs on these guests, and that they are still in the backup job.',
          affected: stale.map((g) => { const at = latest.get(g.id)!.at!; return { label: label(g), nodeId: sourceNode('proxmox', p.inst.id, g.id)?.id, note: `last ${fmtDay(at)}, ${daysAgo(at)} days ago` }; }),
          source: `${p.inst.name} + ${srcName}`,
        });
    }
    if (input.proxmox.length) {
      const known = new Set(input.proxmox.flatMap((p) => p.guests.map((g) => g.id)));
      const orphans = [...latest.entries()].filter(([vmid]) => !known.has(vmid));
      if (orphans.length)
        out.push({
          id: `backup-orphan:${input.backups[0].inst.id}`,
          severity: 'low',
          category: 'hygiene',
          title: `${plural(orphans.length, 'backup is', 'backups are')} for guests that no longer exist`,
          why: 'They take space in the backup folder and in B2, and get copied every night.',
          fix: 'Delete them if the guest is gone for good, or keep one on purpose and snooze this.',
          affected: orphans.map(([vmid, l]) => ({ label: `VM ${vmid}`, note: l.at ? `taken ${fmtDay(l.at)}` : undefined })),
          source: srcName,
        });
    }
  }

  // 4. Certificates in NPM: expiring soon, expired while still in use, or expired leftovers.
  for (const n of input.npm) {
    const certs = n.certificates ?? [];
    if (!certs.length) continue;
    const forced = new Set(
      n.proxyHosts
        .filter((p) => String(p.details?.enabled ?? 'Yes') !== 'No' && !/^off$/i.test(str(p.details?.ssl) ?? 'off'))
        .flatMap((p) => (str(p.details?.domains) ?? p.name).toLowerCase().split(/[,\s]+/).filter(Boolean)),
    );
    const info = certs.map((c) => {
      const exp = parseDay(c.details?.expires_on);
      const domains = (str(c.details?.domains) ?? c.name).toLowerCase().split(/[,\s]+/).filter(Boolean);
      const days = exp ? Math.floor((exp.getTime() - now.getTime()) / DAY) : null;
      return { c, exp, days, domains, used: domains.some((d) => forced.has(d)) };
    });
    // A host can have an old expired cert and a renewed one; "in use" means no valid cert covers it.
    const validFor = new Set(info.filter((i) => i.days != null && i.days >= 0).flatMap((i) => i.domains));
    const expiredUsed = info.filter((i) => i.days != null && i.days < 0 && i.used && !i.domains.some((d) => validFor.has(d)));
    const soon = info.filter((i) => i.days != null && i.days >= 0 && i.days <= CERT_SOON_DAYS);
    const leftovers = info.filter((i) => i.days != null && i.days < 0 && !expiredUsed.includes(i));
    const dnsId = (d: string) => (byId.has(`dns:${d}`) ? `dns:${d}` : undefined);
    if (expiredUsed.length)
      out.push({
        id: `cert-expired-used:${n.inst.id}`,
        severity: 'high',
        category: 'encryption',
        title: `${plural(expiredUsed.length, 'site is', 'sites are')} serving an expired certificate`,
        why: 'Browsers show a security warning, and people learn to click through it.',
        fix: 'Renew the certificate in Nginx Proxy Manager (SSL Certificates → Renew), and check why automatic renewal stopped.',
        affected: expiredUsed.map((i) => ({ label: i.domains[0], nodeId: dnsId(i.domains[0]), note: `expired ${fmtDay(i.exp!)}` })),
        source: n.inst.name,
      });
    if (soon.length)
      out.push({
        id: `cert-soon:${n.inst.id}`,
        severity: soon.some((i) => i.days! <= 3) ? 'high' : 'medium',
        category: 'encryption',
        title: `${plural(soon.length, 'certificate expires', 'certificates expire')} within ${CERT_SOON_DAYS} days`,
        why: 'Let\'s Encrypt certificates normally renew 30 days ahead, so one this close usually means renewal is failing.',
        fix: 'Renew it in Nginx Proxy Manager and check that port 80 still reaches the proxy for the HTTP challenge.',
        affected: soon.map((i) => ({ label: i.domains[0], nodeId: dnsId(i.domains[0]), note: `expires ${fmtDay(i.exp!)}` })),
        source: n.inst.name,
      });
    if (leftovers.length)
      out.push({
        id: `cert-leftover:${n.inst.id}`,
        severity: 'low',
        category: 'hygiene',
        title: `${plural(leftovers.length, 'expired certificate', 'expired certificates')} left in Nginx Proxy Manager`,
        why: 'Nothing serves them, but they clutter the list and hide the one that matters when a real renewal fails.',
        fix: 'Delete them in Nginx Proxy Manager → SSL Certificates.',
        affected: leftovers.map((i) => ({ label: i.domains[0], note: `expired ${fmtDay(i.exp!)}` })),
        source: n.inst.name,
      });
  }

  // 5. Firmware updates waiting on UniFi devices.
  for (const u of input.unifi) {
    const pending = u.devices.filter((d) => /→/.test(str(d.details?.firmware) ?? '') || d.tags?.firmware === 'update available');
    if (!pending.length) continue;
    out.push({
      id: `fw-update:${u.inst.id}`,
      severity: 'medium',
      category: 'patching',
      title: `${plural(pending.length, 'network device has', 'network devices have')} a firmware update`,
      why: 'UniFi firmware updates often carry security fixes for the gateway, switches and access points.',
      fix: 'Read the release notes, then upgrade from UniFi Network (or the device\'s "Upgrade firmware" action in Cerebro) during a quiet hour; each device reboots.',
      affected: pending.map((d) => ({ label: d.name, nodeId: byId.has(`dev:${d.id.toLowerCase()}`) ? `dev:${d.id.toLowerCase()}` : undefined, note: str(d.details?.firmware) ?? undefined })),
      source: u.inst.name,
    });
  }

  // 6. Container images with updates waiting (from the Docker connector's update check).
  //    The ones the internet hits directly (port forward, or a tunnel hostname) get their own, higher finding.
  const fromInternet = new Set(graph.edges.filter((e) => e.source === 'internet' && (e.type === 'forwards' || e.type === 'resolves')).map((e) => e.target));
  const exposed = new Set(graph.edges.filter((e) => e.type === 'forwards' && fromInternet.has(e.source) && byId.get(e.source)?.type === 'dns_name').map((e) => e.target));
  for (const id of fromInternet) exposed.add(id);
  const outdated = graph.nodes.filter((n) => n.type === 'container' && n.roles.includes('Image update'));
  const publicImgs = outdated.filter((n) => exposed.has(n.id));
  const imgs = outdated.filter((n) => !exposed.has(n.id));
  const hostOf = (n: TopoNode) => { const st = n.parent ? byId.get(n.parent) : undefined; return st?.parent ? byId.get(st.parent)?.label : undefined; };
  if (publicImgs.length)
    out.push({
      id: 'image-updates-public',
      severity: 'medium',
      category: 'patching',
      title: `${plural(publicImgs.length, 'internet-facing container runs', 'internet-facing containers run')} an outdated image`,
      why: 'The internet reaches these directly, so a known bug in the old version is the easiest way in.',
      fix: 'Update these first: pull and recreate the stack after checking the release notes.',
      affected: publicImgs.map((n) => ({ label: n.label, nodeId: n.id, note: [n.sublabel, hostOf(n) ? `on ${hostOf(n)}` : null].filter(Boolean).join(' · ') })),
      source: 'Docker',
    });
  if (imgs.length)
    out.push({
      id: 'image-updates',
      severity: 'low',
      category: 'patching',
      title: `${plural(imgs.length, 'container is', 'containers are')} running an outdated image`,
      why: 'A newer image is published for the same tag; it may include security fixes.',
      fix: 'Pull and recreate the stack (or use the container\'s update action) after checking the release notes.',
      affected: imgs.map((n) => ({ label: n.label, nodeId: n.id, note: [n.sublabel, hostOf(n) ? `on ${hostOf(n)}` : null].filter(Boolean).join(' · ') })),
      source: 'Docker',
    });

  // 7. Firewall rules naming addresses no connector has seen.
  const unknown = graph.nodes.filter((n) => n.type === 'host' && n.sources.length === 0);
  if (unknown.length)
    out.push({
      id: 'unknown-addresses',
      severity: 'low',
      category: 'hygiene',
      title: `${plural(unknown.length, 'address', 'addresses')} in firewall rules or links match no known machine`,
      why: 'Rules for machines that are gone are easy to forget, and the address can be handed to something new that then gets the old access.',
      fix: 'Check each one; remove the rule or group entry if the machine is retired.',
      affected: unknown.map((n) => ({ label: n.label, nodeId: n.id })),
      source: 'UniFi',
    });

  // 8. Running VMs without the QEMU guest agent (Proxmox reports no IP).
  for (const p of input.proxmox) {
    const blind = p.guests.filter((g) => g.kind === 'qemu' && g.status === 'running' && !str(g.details?.ip));
    if (!blind.length) continue;
    out.push({
      id: `no-guest-agent:${p.inst.id}`,
      severity: 'low',
      category: 'hygiene',
      title: `${plural(blind.length, 'VM reports', 'VMs report')} no IP (guest agent not running)`,
      why: 'Without the QEMU guest agent, backups can\'t freeze the file system first, shutdowns are less clean, and Cerebro can only match the VM by MAC.',
      fix: 'Install and start qemu-guest-agent inside the VM, and tick "QEMU Guest Agent" under the VM\'s Options in Proxmox.',
      affected: blind.map((g) => ({ label: `${g.name} (VM ${g.id})`, nodeId: sourceNode('proxmox', p.inst.id, g.id)?.id })),
      source: p.inst.name,
    });
  }

  return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

/** What a snooze remembers: until when, and which items it covered. */
export interface Snooze {
  until: string;
  labels: string[];
}

/** Snoozed until the date passes, or until the finding picks up an item it didn't have when snoozed. */
export function isSnoozed(f: PostureFinding, s: Snooze | undefined, now: Date = new Date()): boolean {
  if (!s || new Date(s.until).getTime() <= now.getTime()) return false;
  const had = new Set(s.labels);
  return f.affected.every((a) => had.has(a.label));
}

export function applySnoozes(findings: PostureFinding[], snoozes: Record<string, Snooze>, now: Date = new Date()): PostureFinding[] {
  return findings.map((f) => {
    const s = snoozes[f.id];
    return isSnoozed(f, s, now) ? { ...f, snoozedUntil: s!.until } : { ...f, snoozedUntil: undefined };
  });
}

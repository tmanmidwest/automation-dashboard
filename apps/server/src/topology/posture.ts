import type { ConnectorResource, PostureFinding, PostureSeverity, TopologyGraph, TopoNode } from '@cerebro/shared';
import type { BuildInput } from './topology.builder';
import type { OutsideInData } from './outside-in.service';
import type { ImageScanResult } from './image-scan.service';
import { affects, cmpVersion, type NvdCve } from './version-cve.service';
import type { CtStore } from './ct-log.service';
import type { HibpBreach } from './hibp.service';

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

export function buildFindings(input: BuildInput, graph: TopologyGraph, now: Date = new Date(), intel?: OutsideInData | null, scans?: Record<string, ImageScanResult> | null, versionCves?: VersionCveInput | null, ct?: CtInput | null, hibp?: { domains: string[]; breaches: HibpBreach[] } | null): PostureFinding[] {
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
    const acl = (p: ConnectorResource) => npmAcl(n.accessLists, p);
    // LAN-only hosts (access list allows only private ranges): the internet is turned away.
    const marked = new Set((input.internalNames ?? []).map((x) => x.toLowerCase()));
    const lan = http.filter((p) => acl(p).kind === 'lan' || marked.has(p.name.toLowerCase()));
    const wan = http.filter((p) => !lan.includes(p));
    const login = wan.filter((p) => acl(p).kind === 'login');
    const ipOnly = wan.filter((p) => acl(p).kind === 'ip');
    const unknownAcl = wan.filter((p) => acl(p).kind === 'unknown');
    const open = wan.filter((p) => !ipOnly.includes(p));
    // Names with no public DNS record still answer to anyone who sends that name to the WAN.
    const unlisted = open.filter((p) => publicDnsState(input, p.name) === 'unlisted');
    const listed = open.filter((p) => !unlisted.includes(p));
    const severity: PostureSeverity = !wan.length ? 'low' : port80 && listed.length ? 'high' : 'medium';
    const where = (p: ConnectorResource) => {
      const a = acl(p);
      if (marked.has(p.name.toLowerCase()) && a.kind !== 'lan') return 'marked internal';
      if (a.kind === 'lan') return `access list ${a.name} (LAN only)`;
      if (a.kind === 'login') return `access list ${a.name} (password)`;
      if (a.kind === 'ip') return `access list ${a.name} (IP allow-list)`;
      if (a.name) return `access list ${a.name}`;
      return null;
    };
    out.push({
      id: `npm-http:${n.inst.id}`,
      severity,
      category: 'encryption',
      title: !wan.length
        ? `${plural(http.length, 'LAN-only proxy host')} served over plain HTTP`
        : login.length
          ? `${plural(http.length, 'proxy host')} served over plain HTTP, ${login.length === http.length ? 'all' : login.length} with a password login`
          : `${plural(http.length, 'proxy host')} served over plain HTTP`,
      why: (
        (wan.length && port80
          ? `WAN port 80 is forwarded to this proxy ("${port80.pf.name}"), so ${lan.length ? 'the hosts not limited to your LAN' : 'these'} are reachable from the internet without encryption. `
          : wan.length
            ? 'Traffic to these names is unencrypted on the network. '
            : '') +
        (login.length
          ? `${plural(login.length, 'of them asks', 'of them ask')} for a username and password (access list "${acl(login[0]).name}"), and that login travels in clear text, readable by anyone on the path. `
          : '') +
        (ipOnly.length
          ? `${plural(ipOnly.length, 'is', 'are')} limited to certain IP addresses (access list "${acl(ipOnly[0]).name}"), so outsiders are turned away from ${ipOnly.length === 1 ? 'it' : 'those'}. `
          : '') +
        (lan.length
          ? `${plural(lan.length, 'is', 'are')} limited to your local network by ${lan.length === 1 ? 'its' : 'their'} access list, so internet requests are refused${wan.length ? '' : ', but the traffic inside your network is still unencrypted'}. `
          : '') +
        (unlisted.length && port80
          ? `${plural(unlisted.length, 'has', 'have')} no public DNS record, which keeps ${unlisted.length === 1 ? 'it' : 'them'} out of sight but not closed: anyone who sends the name to your WAN address still reaches ${unlisted.length === 1 ? 'it' : 'them'}, and names leak through certificate logs. `
          : '') +
        (unknownAcl.length ? `${plural(unknownAcl.length, 'is', 'are')} behind an access list Cerebro couldn't read; if it asks for a password, that travels in clear text too. ` : '') +
        (!wan.some((p) => acl(p).name) && wan.length ? 'Anyone on the path can read or change what is sent.' : '')).trim(),
      fix: wan.length
        ? 'In Nginx Proxy Manager, request a Let\'s Encrypt certificate for each host and turn on "Force SSL". To keep a host internal, give it an access list that allows only your LAN ranges.'
        : 'Low priority: add a certificate and "Force SSL" when convenient (a DNS-challenge certificate works for internal-only names).',
      affected: http.map((p) => ({
        label: p.name,
        nodeId: byId.has(`dns:${p.name.toLowerCase()}`) ? `dns:${p.name.toLowerCase()}` : undefined,
        note: [str(p.details?.forward), where(p), unlisted.includes(p) ? 'not in public DNS' : null].filter(Boolean).join(' · '),
      })),
      alsoOn: wan.length && port80?.ip ? [nodeByIp.get(port80.ip)?.id].filter((x): x is string => !!x) : undefined,
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
        (f.iface === 'all' ? ' It listens on every WAN interface.' : '') +
        (() => {
          const seen = intel?.wan.filter((w) => f.wanPort && w.ports.includes(Number(f.wanPort))) ?? [];
          if (seen.length) return ` Shodan's scanners have already found it open on ${seen.map((w) => w.ip).join(', ')}.`;
          if (intel?.wan.length) return ` Shodan hasn't listed this port yet, but scanners sweep every port, so assume it's known.`;
          return '';
        })(),
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

  // 7. Firewall rules, DNS records and tunnels naming addresses no connector has seen.
  const unknown = graph.nodes.filter((n) => n.type === 'host' && n.sources.length === 0);
  if (unknown.length)
    out.push({
      id: 'unknown-addresses',
      severity: 'low',
      category: 'hygiene',
      title: `${plural(unknown.length, 'address', 'addresses')} in firewall rules or DNS records match no known machine`,
      why: 'Rules for machines that are gone are easy to forget, and the address can be handed to something new that then gets the old access.',
      fix: 'Each address lists what still names it. If the machine is retired, remove that rule, group entry or DNS record; it drops off here on the next map refresh.',
      affected: unknown.map((n) => ({ label: n.label, nodeId: n.id, note: usedBy(graph, n) })),
      source: 'UniFi rules, DNS records and tunnels',
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

  if (intel) out.push(...outsideInFindings(input, graph, intel, now));
  if (scans) out.push(...imageCveFindings(input, graph, scans, intel ?? null));
  if (versionCves) out.push(...versionCveFindings(versionCves, intel ?? null));
  if (ct) out.push(...ctLogFindings(input, graph, ct, now));
  if (hibp) out.push(...hibpFindings(hibp.domains, hibp.breaches, now));

  return sortFindings(out);
}

/** Worst first, then by category and title. */
export function sortFindings(out: PostureFinding[]): PostureFinding[] {
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


// ── outside-in (Shodan InternetDB, CISA KEV, endoflife.date) ───────────────

/** Docker image repo (last path part) → endoflife.date product. Only products whose tags carry the release. */
const EOL_PRODUCTS: Record<string, string> = {
  postgres: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', redis: 'redis', mongo: 'mongodb', node: 'nodejs',
  python: 'python', nginx: 'nginx', php: 'php', ubuntu: 'ubuntu', debian: 'debian', alpine: 'alpine', golang: 'go',
  rabbitmq: 'rabbitmq', elasticsearch: 'elasticsearch', traefik: 'traefik', haproxy: 'haproxy', memcached: 'memcached',
  influxdb: 'influxdb', grafana: 'grafana', 'eclipse-mosquitto': 'mosquitto', wordpress: 'wordpress', nextcloud: 'nextcloud',
  'home-assistant': 'home-assistant', homeassistant: 'home-assistant', gitea: 'gitea', keycloak: 'keycloak', tomcat: 'tomcat',
  httpd: 'apache', valkey: 'valkey',
};

/** "lscr.io/linuxserver/nginx:1.25-alpine" → { product: "nginx", version: "1.25" }; null when untagged / "latest" / unknown. */
export function imageRelease(image: string): { product: string; version: string } | null {
  const noDigest = image.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon <= slash) return null;
  const repo = noDigest.slice(slash + 1, colon).toLowerCase();
  const tag = noDigest.slice(colon + 1);
  const product = EOL_PRODUCTS[repo];
  const version = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1];
  return product && version ? { product, version } : null;
}

/** The release cycle a version belongs to: exact match, else the longest cycle it starts with. */
export function cycleFor(version: string, cycles: { cycle: string }[]): string | null {
  let best: string | null = null;
  for (const { cycle } of cycles) {
    if (version === cycle || version.startsWith(`${cycle}.`)) if (!best || cycle.length > best.length) best = cycle;
  }
  return best;
}

/** Shodan CPE "vendor:product" → endoflife.date product, and whether it's a browser-side library. */
const CPE_PRODUCTS: Record<string, { product: string; clientSide?: boolean }> = {
  'getbootstrap:bootstrap': { product: 'bootstrap', clientSide: true },
  'jquery:jquery': { product: 'jquery', clientSide: true },
  'angularjs:angular.js': { product: 'angularjs', clientSide: true },
  'f5:nginx': { product: 'nginx' }, 'nginx:nginx': { product: 'nginx' },
  'apache:http_server': { product: 'apache' }, 'apache:tomcat': { product: 'tomcat' },
  'php:php': { product: 'php' }, 'openssl:openssl': { product: 'openssl' }, 'openbsd:openssh': { product: 'openssh' },
  'wordpress:wordpress': { product: 'wordpress' }, 'microsoft:internet_information_services': { product: 'iis' },
  'drupal:drupal': { product: 'drupal' }, 'nodejs:node.js': { product: 'nodejs' },
};

/** "cpe:/a:getbootstrap:bootstrap:3.4.1" → { product: "bootstrap", version: "3.4.1" }; null without a version. */
export function cpeRelease(cpe: string): { product: string; version: string; clientSide: boolean; name: string } | null {
  const parts = cpe.replace(/^cpe:(2\.3:|\/)/, '').split(':');
  // 2.3 form: a:vendor:product:version…; 2.2 form: a:vendor:product:version
  const [, vendor, prod, ver] = parts;
  const hit = vendor && prod ? CPE_PRODUCTS[`${vendor.toLowerCase()}:${prod.toLowerCase()}`] : undefined;
  const version = ver && /^\d+(\.\d+)*/.exec(ver)?.[0];
  return hit && version ? { product: hit.product, version, clientSide: !!hit.clientSide, name: prod } : null;
}

/** endoflife.date products the running images map to (for the service to fetch). */
export function eolProducts(input: BuildInput): string[] {
  const out = new Set<string>();
  for (const d of input.docker) for (const c of d.containers) {
    const r = imageRelease(String(c.details?.image ?? ''));
    if (r) out.add(r.product);
  }
  return [...out].sort();
}

/** Public WAN addresses: the UniFi gateways' reported IPs. */
export function wanIps(input: BuildInput): string[] {
  const out = new Set<string>();
  for (const u of input.unifi) for (const d of u.devices) {
    const t = String(d.details?.type ?? d.tags?.type ?? '').toLowerCase();
    const ip = str(d.details?.ip);
    if (t.includes('gateway') && isIp(ip) && !isPrivateIp(ip)) out.add(ip);
  }
  return [...out];
}

function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

const BAD_TAGS: Record<string, PostureSeverity> = { compromised: 'high', malware: 'high', c2: 'high', botnet: 'high', 'eol-os': 'medium', 'eol-product': 'medium', 'self-signed': 'low' };

function outsideInFindings(input: BuildInput, graph: TopologyGraph, intel: OutsideInData, now: Date): PostureFinding[] {
  const out: PostureFinding[] = [];
  const forwarded = new Set(
    input.unifi.flatMap((u) => u.portForwards.filter((pf) => String(pf.status ?? '').toLowerCase() !== 'disabled').map((pf) => Number(str(pf.details?.port)))),
  );

  for (const w of intel.wan) {
    // 1. Ports Shodan sees open that no port forward explains (the gateway itself, UPnP, a forgotten rule…).
    const stray = w.ports.filter((p) => !forwarded.has(p));
    if (stray.length)
      out.push({
        id: `wan-stray-ports:${w.ip}`,
        severity: 'high',
        category: 'exposure',
        title: `${plural(stray.length, 'port is', 'ports are')} open on your WAN address with no port forward behind ${stray.length === 1 ? 'it' : 'them'}`,
        why: `Shodan's scanners found ${stray.join(', ')} open on ${w.ip}, but no UniFi port forward uses ${stray.length === 1 ? 'that port' : 'those ports'}. That usually means the gateway itself is answering (remote management, VPN, a UPnP mapping a device opened), or a rule that isn't in the forward list.`,
        fix: 'Check UniFi → Settings → Security / Internet → UPnP, remote access and VPN servers. Close the port if you don\'t recognise it; Shodan updates its data every few days.',
        affected: stray.map((p) => ({ label: `${w.ip}:${p}`, url: shodanUrl(w.ip), note: `seen by Shodan (checked ${w.checkedAt.slice(0, 10)})` })),
        alsoOn: ['internet'],
        source: 'Shodan InternetDB',
      });

    // 2. CVEs Shodan matched to the software it saw; CISA KEV marks the ones exploited in the wild.
    if (w.vulns.length) {
      const kev = w.vulns.filter((v) => intel.kev.has(v.toUpperCase()));
      out.push({
        id: `wan-vulns:${w.ip}`,
        severity: kev.length ? 'high' : 'medium',
        category: 'patching',
        title: kev.length
          ? `Your WAN address shows ${plural(kev.length, 'vulnerability', 'vulnerabilities')} known to be exploited`
          : `Shodan lists ${plural(w.vulns.length, 'known vulnerability', 'known vulnerabilities')} for your WAN address`,
        why:
          'Shodan matched these CVEs to the software versions your public ports announce. It goes by version banners, so some may not apply (a patched build can keep the old version string).' +
          (kev.length ? ` ${kev.length === 1 ? 'One is' : `${kev.length} are`} on CISA's Known Exploited Vulnerabilities list: attackers are using ${kev.length === 1 ? 'it' : 'them'} now.` : ''),
        fix: 'Update the internet-facing software (the proxy on 80/443, or whatever the port forward points at). Afterwards Shodan re-scans within a few days and the list should shrink.',
        affected: [...kev, ...w.vulns.filter((v) => !kev.includes(v))].map((v) => {
          const k = intel.kev.get(v.toUpperCase());
          return { label: v, url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v)}`, note: k ? `CISA KEV: ${k.vulnerabilityName ?? k.product ?? ''}${k.knownRansomwareCampaignUse === 'Known' ? ' · used by ransomware' : ''}`.trim() : undefined };
        }),
        source: kev.length ? 'Shodan InternetDB + CISA KEV' : 'Shodan InternetDB',
      });
    }

    // 3. Tags Shodan puts on the IP.
    for (const tag of w.tags) {
      const sev = BAD_TAGS[tag];
      if (!sev) continue;
      out.push({
        id: `wan-tag:${w.ip}:${tag}`,
        severity: sev,
        category: sev === 'high' ? 'exposure' : 'hygiene',
        title: `Shodan tags your WAN address "${tag}"`,
        why: sev === 'high'
          ? 'Shodan saw behaviour on this address that matches compromised or malware-controlled machines.'
          : tag === 'self-signed'
            ? 'A public port serves a self-signed certificate, so browsers warn and people learn to click through.'
            : 'A public port announces software that is past its end of life.',
        fix: sev === 'high' ? 'Treat it as an incident: check what answers on the open ports and which machine they forward to.' : 'Find which forward serves it and update or close it.',
        affected: [{ label: w.ip, url: shodanUrl(w.ip), note: `ports ${w.ports.join(', ') || 'none'}` }],
        alsoOn: ['internet'],
        source: 'Shodan InternetDB',
      });
    }
  }

  // 4. Software your public ports announce that is past its end of life (Shodan CPEs + endoflife.date).
  for (const w of intel.wan) {
    const hits: { label: string; note: string; clientSide: boolean }[] = [];
    for (const cpe of w.cpes) {
      const r = cpeRelease(cpe);
      const cycles = r ? intel.eol.get(r.product) : undefined;
      if (!r || !cycles?.length) continue;
      const cyc = cycleFor(r.version, cycles);
      const info = cyc ? cycles.find((x) => x.cycle === cyc) : undefined;
      const end = info && info.eol !== true && info.eol !== false ? parseDay(info.eol) : null;
      if (!info || !(info.eol === true || (end && end <= now))) continue;
      hits.push({ label: `${r.name} ${r.version}`, clientSide: r.clientSide, note: `${r.product} ${cyc} support ended${end ? ` ${fmtDayUTC(end)}` : ''}${cycles[0]?.cycle && cycles[0].cycle !== cyc ? ` · current ${cycles[0].cycle}` : ''}` });
    }
    if (hits.length)
      out.push({
        id: `wan-eol:${w.ip}`,
        severity: hits.every((h) => h.clientSide) ? 'low' : 'medium',
        category: 'patching',
        title: `Your public website${w.ports.length > 1 ? 's' : ''} announce${w.ports.length > 1 ? '' : 's'} software past its end of life`,
        why:
          `Shodan saw ${hits.map((h) => h.label).join(', ')} on ${w.ip} (ports ${w.ports.join(', ')}). These releases no longer get fixes.` +
          (hits.every((h) => h.clientSide) ? ' They are browser-side libraries, so the risk is mostly cross-site scripting in the page that loads them, often a default or error page.' : ''),
        fix:
          'Scanners visit your bare WAN address, not your host names, so what they saw is the page served when no host name matches, usually the proxy\'s default site. ' +
          'Open the links below to see it. In Nginx Proxy Manager, Settings → Default Site → "No Response (444)" or "404 Page" removes that page (and stops answering scanners with a page at all).',
        affected: [
          ...hits.map((h) => ({ label: h.label, note: h.note, url: shodanUrl(w.ip) })),
          ...w.ports.filter((p) => p === 80 || p === 443).map((p) => ({ label: `Open ${p === 443 ? 'https' : 'http'}://${w.ip}/`, url: `${p === 443 ? 'https' : 'http'}://${w.ip}/`, note: 'the page scanners see' })),
        ],
        alsoOn: ['internet'],
        source: 'Shodan InternetDB + endoflife.date',
      });
  }

  // 5. Containers running a release that is past its end of life (endoflife.date).
  const fromInternet = new Set(graph.edges.filter((e) => e.source === 'internet' && (e.type === 'forwards' || e.type === 'resolves')).map((e) => e.target));
  const ctrNode = (instId: string, id: string) => graph.nodes.find((n) => n.id === `ctr:${instId}:${id.slice(0, 12)}`);
  const eolHits: { label: string; nodeId?: string; note: string; exposed: boolean }[] = [];
  const soonHits: { label: string; nodeId?: string; note: string }[] = [];
  for (const d of input.docker) for (const c of d.containers) {
    const image = String(c.details?.image ?? '');
    const r = imageRelease(image);
    const cycles = r ? intel.eol.get(r.product) : undefined;
    if (!r || !cycles?.length) continue;
    const cyc = cycleFor(r.version, cycles);
    const info = cyc ? cycles.find((x) => x.cycle === cyc) : undefined;
    if (!info || info.eol === false) continue;
    const end = info.eol === true ? null : parseDay(info.eol);
    const node = ctrNode(d.inst.id, c.id);
    const newest = cycles[0]?.cycle;
    const label = node?.label ?? c.name;
    if (info.eol === true || (end && end <= now)) {
      eolHits.push({ label, nodeId: node?.id, exposed: !!node && fromInternet.has(node.id), note: `${image} · ${r.product} ${cyc} ended${end ? ` ${fmtDayUTC(end)}` : ''}${newest && newest !== cyc ? ` · current ${newest}` : ''} · on ${d.inst.name}` });
    } else if (end && end.getTime() - now.getTime() <= 90 * DAY) {
      soonHits.push({ label, nodeId: node?.id, note: `${image} · ${r.product} ${cyc} support ends ${fmtDayUTC(end)} · on ${d.inst.name}` });
    }
  }
  if (eolHits.length)
    out.push({
      id: 'image-eol',
      severity: eolHits.some((h) => h.exposed) ? 'high' : 'medium',
      category: 'patching',
      title: `${plural(eolHits.length, 'container runs', 'containers run')} a release past its end of life`,
      why: 'These releases no longer get security fixes, so any bug found from now on stays open.' + (eolHits.some((h) => h.exposed) ? ' At least one of them is reachable from the internet.' : ''),
      fix: 'Move the image tag to a supported release (check the app\'s upgrade notes; databases usually need a dump and restore between major versions).',
      affected: eolHits.map(({ label, nodeId, note }) => ({ label, nodeId, note })),
      source: 'endoflife.date + Docker',
    });
  if (soonHits.length)
    out.push({
      id: 'image-eol-soon',
      severity: 'low',
      category: 'patching',
      title: `${plural(soonHits.length, 'container runs', 'containers run')} a release whose support ends within 90 days`,
      why: 'After that date the release stops getting security fixes.',
      fix: 'Plan the move to a newer release before the date.',
      affected: soonHits,
      source: 'endoflife.date + Docker',
    });

  return out;
}

const fmtDayUTC = (d: Date) => d.toISOString().slice(0, 10);
const shodanUrl = (ip: string) => `https://www.shodan.io/host/${encodeURIComponent(ip)}`;


// ── container image CVEs (Trivy results + CISA KEV) ────────────────────────

function imageCveFindings(input: BuildInput, graph: TopologyGraph, scans: Record<string, ImageScanResult>, intel: OutsideInData | null): PostureFinding[] {
  const out: PostureFinding[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const fromInternet = new Set(graph.edges.filter((e) => e.source === 'internet' && (e.type === 'forwards' || e.type === 'resolves')).map((e) => e.target));
  for (const e of graph.edges) if (e.type === 'forwards' && fromInternet.has(e.source) && byId.get(e.source)?.type === 'dns_name') fromInternet.add(e.target);
  const nvd = (id: string) => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`;

  type Row = { label: string; nodeId?: string; exposed: boolean; scan: ImageScanResult; image: string; host: string };
  const rows: Row[] = [];
  for (const d of input.docker) for (const c of d.containers) {
    const rd = str(c.details?.repo_digest);
    const scan = rd ? scans[rd] : undefined;
    if (!scan || scan.error) continue;
    const nodeId = `ctr:${d.inst.id}:${c.id.slice(0, 12)}`;
    const node = byId.get(nodeId);
    rows.push({ label: c.name || node?.label || c.id.slice(0, 12), nodeId: node ? nodeId : undefined, exposed: fromInternet.has(nodeId), scan, image: str(c.details?.image) ?? rd!, host: d.inst.name });
  }
  const top = (s: ImageScanResult, pred: (v: ImageScanResult['vulns'][number]) => boolean) => s.vulns.find(pred);
  const example = (v?: ImageScanResult['vulns'][number]) => (v ? `e.g. ${v.id} in ${v.pkg} ${v.installed}${v.fixed ? ` → ${v.fixed}` : ' (no fix yet)'}` : '');
  const urlOf = (v?: ImageScanResult['vulns'][number]) => (v ? nvd(v.id) : undefined);
  const countsText = (s: ImageScanResult) => [s.counts.critical && `${s.counts.critical} critical`, s.counts.high && `${s.counts.high} high`, `${s.counts.fixable} fixable`].filter(Boolean).join(', ');

  // 1. CVEs on CISA's Known Exploited list.
  if (intel?.kev.size) {
    const kevRows = rows
      .map((r) => ({ r, kev: r.scan.ids.filter((id) => intel.kev.has(id.toUpperCase())) }))
      .filter((x) => x.kev.length);
    if (kevRows.length)
      out.push({
        id: 'image-cve-kev',
        severity: 'high',
        category: 'patching',
        title: `${plural(kevRows.length, 'container runs', 'containers run')} an image with an actively exploited vulnerability`,
        why: "These CVEs are on CISA's Known Exploited Vulnerabilities list: attackers are using them now." + (kevRows.some((x) => x.r.exposed) ? ' At least one of these containers is reachable from the internet.' : ''),
        fix: 'Update the image (pull a newer tag or digest and recreate the container). If no fixed release exists yet, limit who can reach the container.',
        affected: kevRows.map(({ r, kev }) => {
          const k = intel.kev.get(kev[0].toUpperCase());
          return { label: r.label, nodeId: r.nodeId, url: nvd(kev[0]), note: `${kev.join(', ')}${k?.vulnerabilityName ? ` (${k.vulnerabilityName})` : ''} · ${r.image} · on ${r.host}${r.exposed ? ' · internet-facing' : ''}` };
        }),
        source: 'Trivy + CISA KEV',
      });
  }

  // 2. Critical CVEs with a fix available.
  const crit = rows.filter((r) => r.scan.vulns.some((v) => v.severity === 'CRITICAL' && v.fixed));
  if (crit.length)
    out.push({
      id: 'image-cve-critical',
      severity: crit.some((r) => r.exposed) ? 'high' : 'medium',
      category: 'patching',
      title: `${plural(crit.length, 'container has', 'containers have')} critical vulnerabilities with a fix available`,
      why: 'A fixed version of the affected package exists, so updating the image usually clears these.' + (crit.some((r) => r.exposed) ? ' At least one is reachable from the internet.' : ''),
      fix: 'Pull the newest image for the tag and recreate the container. If the newest image still has them, the maintainer hasn\'t rebuilt yet; check again in a few days or pin a newer tag.',
      affected: crit
        .sort((a, b) => Number(b.exposed) - Number(a.exposed) || b.scan.counts.critical - a.scan.counts.critical)
        .map((r) => ({ label: r.label, nodeId: r.nodeId, url: urlOf(top(r.scan, (v) => v.severity === 'CRITICAL' && !!v.fixed)), note: `${countsText(r.scan)} · ${example(top(r.scan, (v) => v.severity === 'CRITICAL' && !!v.fixed))} · ${r.image} · on ${r.host}${r.exposed ? ' · internet-facing' : ''}` })),
      source: 'Trivy',
    });

  // 3. High CVEs with a fix (and no fixable critical).
  const high = rows.filter((r) => !crit.includes(r) && r.scan.vulns.some((v) => v.severity === 'HIGH' && v.fixed));
  if (high.length)
    out.push({
      id: 'image-cve-high',
      severity: 'low',
      category: 'patching',
      title: `${plural(high.length, 'container has', 'containers have')} high-severity vulnerabilities with a fix available`,
      why: 'Not critical, but fixed versions exist; they usually clear with the next image update.',
      fix: 'Update these images during normal maintenance.',
      affected: high.map((r) => ({ label: r.label, nodeId: r.nodeId, url: urlOf(top(r.scan, (v) => v.severity === 'HIGH' && !!v.fixed)), note: `${countsText(r.scan)} · ${example(top(r.scan, (v) => v.severity === 'HIGH' && !!v.fixed))} · ${r.image} · on ${r.host}` })),
      source: 'Trivy',
    });

  return out;
}


// ── known CVEs for infrastructure software versions (NVD) ──────────────────

/** One installed product version to look up: `cpe` is NVD's "vendor:product". */
export interface ProductVersion {
  cpe: string;
  product: string;
  version: string;
  where: string;
  nodeId?: string;
}
export interface VersionCveInput {
  products: ProductVersion[];
  /** NVD answers per cpe (VersionCveService.cached()). */
  cves: Record<string, { cves: NvdCve[] } | undefined>;
}

/** Product versions Cerebro knows, from connection tests (`tested[instanceId].version`) and UniFi device firmware. */
export function productVersions(input: BuildInput, graph: TopologyGraph, tested: Record<string, Record<string, unknown> | null>): ProductVersion[] {
  const out: ProductVersion[] = [];
  const ver = (v: unknown) => {
    const m = /\d+(?:\.\d+)+/.exec(String(v ?? ''));
    return m ? m[0] : null;
  };
  for (const p of input.proxmox) {
    const v = ver(tested[p.inst.id]?.version);
    const node = graph.nodes.find((n) => n.roles.includes('Proxmox node') && n.sources.some((s) => s.connectorId === 'proxmox' && s.instanceId === p.inst.id));
    if (v) out.push({ cpe: 'proxmox:virtual_environment', product: 'Proxmox VE', version: v, where: p.inst.name, nodeId: node?.id });
  }
  for (const n of input.npm) {
    const v = ver(tested[n.inst.id]?.version);
    const node = n.baseHost ? graph.nodes.find((x) => x.ips.includes(n.baseHost!)) : undefined;
    if (v) out.push({ cpe: 'jc21:nginx_proxy_manager', product: 'Nginx Proxy Manager', version: v, where: n.inst.name, nodeId: node?.id });
  }
  for (const u of input.unifi) {
    const v = ver(tested[u.inst.id]?.version);
    const gw = u.devices.find((d) => /gateway/i.test(String(d.details?.type ?? '')));
    if (v) out.push({ cpe: 'ui:unifi_network_application', product: 'UniFi Network', version: v, where: u.inst.name, nodeId: gw ? `dev:${gw.id.toLowerCase()}` : undefined });
    for (const d of u.devices) {
      const t = String(d.details?.type ?? '');
      // "5.1.34.34103": the 4th part is a build number; NVD ranges use the release (5.1.34).
      const fw = ver(d.details?.firmware)?.split('.').slice(0, 3).join('.');
      if (!fw) continue;
      // A UniFi console's firmware version is its UniFi OS version.
      if (/gateway/i.test(t)) out.push({ cpe: 'ui:unifi_os', product: 'UniFi OS', version: fw, where: d.name, nodeId: `dev:${d.id.toLowerCase()}` });
      else if (/switch/i.test(t)) out.push({ cpe: 'ui:unifi_switch_firmware', product: 'UniFi switch firmware', version: fw, where: d.name, nodeId: `dev:${d.id.toLowerCase()}` });
      // Access points: NVD has no CPE for current AP firmware, so there's nothing to match.
    }
  }
  return out;
}

function versionCveFindings(vc: VersionCveInput, intel: OutsideInData | null): PostureFinding[] {
  const out: PostureFinding[] = [];
  // Same product + version on several devices (e.g. switches) → one finding.
  const groups = new Map<string, ProductVersion[]>();
  for (const p of vc.products) {
    const k = `${p.cpe}|${p.version}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const ps of groups.values()) {
    const { cpe, product, version } = ps[0];
    const hits = (vc.cves[cpe]?.cves ?? [])
      .map((c) => ({ c, r: affects(version, c), kev: intel?.kev.get(c.id.toUpperCase()) }))
      .filter((h): h is { c: NvdCve; r: NonNullable<ReturnType<typeof affects>>; kev: ReturnType<NonNullable<typeof intel>['kev']['get']> } => !!h.r);
    if (!hits.length) continue;
    const kevN = hits.filter((h) => h.kev).length;
    const critN = hits.filter((h) => h.c.severity === 'CRITICAL').length;
    const highN = hits.filter((h) => h.c.severity === 'HIGH').length;
    const severity: PostureSeverity = kevN || critN ? 'high' : highN ? 'medium' : 'low';
    // The lowest version clear of every matched range ("fixed in").
    const fixes = hits.map((h) => (h.r.end && !h.r.endIncl ? h.r.end : null)).filter((x): x is string => !!x);
    const fixAt = fixes.sort(cmpVersion).pop();
    const nvd = (id: string) => `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`;
    hits.sort((a, b) => Number(!!b.kev) - Number(!!a.kev) || (b.c.score ?? 0) - (a.c.score ?? 0));
    out.push({
      id: `version-cve-${cpe.replace(/[^a-z0-9]+/gi, '-')}`,
      severity,
      category: 'patching',
      title: `${product} ${version} has ${plural(hits.length, 'known vulnerability', 'known vulnerabilities')}`,
      why:
        `NVD lists ${hits.length === 1 ? 'this CVE' : 'these CVEs'} for ${product} ${version}` +
        (critN || highN ? ` (${[critN && `${critN} critical`, highN && `${highN} high`].filter(Boolean).join(', ')})` : '') +
        '.' + (kevN ? ` ${plural(kevN, 'is', 'are')} on CISA's Known Exploited list, so attackers are using ${kevN === 1 ? 'it' : 'them'} now.` : ''),
      fix: fixAt ? `Update ${product} to ${fixAt} or later.` : `Update ${product} to the newest release; check each CVE for the fixed version.`,
      affected: [
        ...ps.map((p) => ({ label: p.where, nodeId: p.nodeId, note: `${product} ${version}` })),
        ...hits.slice(0, 15).map((h) => ({
          label: h.c.id,
          url: nvd(h.c.id),
          note: [
            h.c.score != null ? `CVSS ${h.c.score}${h.c.severity ? ` ${h.c.severity.toLowerCase()}` : ''}` : null,
            h.r.end ? (h.r.endIncl ? `affects up to ${h.r.end}` : `fixed in ${h.r.end}`) : h.r.exact ? `affects ${h.r.exact}` : null,
            h.kev ? 'on CISA KEV' : null,
            h.c.summary ?? null,
          ].filter(Boolean).join(' · '),
        })),
      ],
      source: kevN ? 'NVD + CISA KEV' : 'NVD',
    });
  }
  return out;
}



// ── certificate transparency (crt.sh) ─────────────────────────────────────

export interface CtInput {
  /** Cloudflare DNS record names (the map doesn't carry these). */
  extraNames: string[];
  store: CtStore;
}

/** Your public domains: Cloudflare zones plus the registrable part of every proxied/tunnelled name. */
export function ctDomains(graph: TopologyGraph, zones: string[], registrable: (n: string) => string | null): string[] {
  const out = new Set(zones.map((z) => z.toLowerCase()));
  for (const n of graph.nodes) if (n.type === 'dns_name') { const r = registrable(n.label); if (r) out.add(r); }
  return [...out].sort();
}

const NEW_DAYS = 14;

function ctLogFindings(input: BuildInput, graph: TopologyGraph, ct: CtInput, now: Date): PostureFinding[] {
  const out: PostureFinding[] = [];
  const known = new Set<string>(ct.extraNames.map((n) => n.toLowerCase().replace(/\.$/, '')));
  for (const n of graph.nodes) if (n.type === 'dns_name') known.add(n.label.toLowerCase());
  for (const n of input.npm) {
    for (const h of n.proxyHosts) for (const d of String(h.details?.domains ?? h.name ?? '').split(/[\s,]+/)) if (d) known.add(d.toLowerCase());
    for (const c of n.certificates ?? []) for (const d of String(c.details?.domains ?? c.name ?? '').split(/[\s,]+/)) if (d) known.add(d.toLowerCase());
  }
  const domains = Object.keys(ct.store);
  const isKnown = (name: string) => {
    if (name.startsWith('*.')) return true; // a wildcard says nothing about which names you use
    if (known.has(name) || domains.includes(name) || domains.some((d) => name === `www.${d}`)) return true;
    // Covered by one of your own wildcard records/hosts.
    for (const k of known) if (k.startsWith('*.') && name.endsWith(k.slice(1)) && !name.slice(0, -k.length + 1).includes('.')) return true;
    return false;
  };
  const t = (iso: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
  const crt = (id: number, name?: string) => (id > 0 ? `https://crt.sh/?id=${id}` : `https://crt.sh/?q=${encodeURIComponent(name ?? '')}`);
  const newCut = now.getTime() - NEW_DAYS * DAY;

  type Item = { label: string; url: string; note: string };
  const fresh: Item[] = [];
  const stale = new Map<string, Item & { at: number }>();
  for (const [domain, e] of Object.entries(ct.store)) {
    const certs = e.certs.filter((c) => t(c.notAfter) > now.getTime());
    const issuersBefore = new Set(e.certs.filter((c) => t(c.notBefore) < newCut).map((c) => c.issuer.replace(/\s*\(.*\)$/, '')));
    for (const c of certs) {
      const unknown = c.names.filter((n) => (n === domain || n.endsWith(`.${domain}`)) && !isKnown(n));
      const isNew = t(c.notBefore) >= newCut;
      const org = c.issuer.replace(/\s*\(.*\)$/, '');
      // Cloudflare's edge certificates (apex + wildcard only) switch CAs on their own; not a signal.
      const edgeOnly = c.names.every((n) => n === domain || n === `*.${domain}`);
      const newIssuer = isNew && !edgeOnly && issuersBefore.size > 0 && !issuersBefore.has(org);
      if (isNew && (unknown.length || newIssuer)) {
        fresh.push({
          label: (unknown.length ? unknown : c.names).slice(0, 3).join(', ') + (Math.max(unknown.length, c.names.length) > 3 ? ' …' : ''),
          url: crt(c.id, (unknown[0] ?? c.names[0])),
          note: [`issued ${fmtDayUTC(new Date(t(c.notBefore)))} by ${c.issuer}`, unknown.length ? 'name not in Cerebro' : null, newIssuer ? `a CA ${domain} hasn't used before` : null].filter(Boolean).join(' · '),
        });
      } else if (!isNew) {
        for (const n of unknown) {
          const prev = stale.get(n);
          if (!prev || prev.at < t(c.notBefore)) stale.set(n, { label: n, url: crt(c.id, n), note: `certificate from ${fmtDayUTC(new Date(t(c.notBefore)))} by ${c.issuer}, valid to ${fmtDayUTC(new Date(t(c.notAfter)))}`, at: t(c.notBefore) });
        }
      }
    }
  }
  // A name already flagged as new isn't listed again as stale.
  if (fresh.length)
    out.push({
      id: 'ct-new-certs',
      severity: 'medium',
      category: 'exposure',
      title: `${plural(fresh.length, 'certificate was', 'certificates were')} issued for your domains in the last ${NEW_DAYS} days that ${fresh.length === 1 ? "doesn't" : "don't"} match what Cerebro knows`,
      why: "Every public certificate is logged in Certificate Transparency. One for a name you don't serve, or from a CA you don't use, can mean someone else got a certificate for your domain (a hijacked DNS record or account), or a service you set up outside what Cerebro sees.",
      fix: 'Open each one on crt.sh. If you recognise it (a new service, Microsoft 365, a hosted app), add it to Cloudflare/NPM or snooze this. If not, check who controls that DNS name and revoke the certificate through the issuing CA.',
      affected: fresh.slice(0, 25),
      source: 'crt.sh',
    });
  const staleItems = [...stale.values()].sort((a, b) => b.at - a.at).map(({ at: _at, ...i }) => i);
  if (staleItems.length)
    out.push({
      id: 'ct-unknown-names',
      severity: 'low',
      category: 'exposure',
      title: `${plural(staleItems.length, 'hostname has', 'hostnames have')} a valid public certificate but nothing in Cerebro serves ${staleItems.length === 1 ? 'it' : 'them'}`,
      why: "Anyone can list these names from the public certificate logs. If one is left over from a service you removed, its DNS record may still point somewhere you don't control any more (a subdomain takeover).",
      fix: 'Remove DNS records for names you no longer use. Names served by something Cerebro doesn\'t watch (a hosted service) are fine; snooze this.',
      affected: staleItems.slice(0, 30),
      source: 'crt.sh',
    });
  return out;
}


// ── Have I Been Pwned (free catalogue: was a site on your domains breached?) ─

function hibpFindings(domains: string[], breaches: HibpBreach[], now: Date): PostureFinding[] {
  const hits = breaches.filter((b) => domains.some((d) => b.domain === d || b.domain.endsWith(`.${d}`)));
  if (!hits.length) return [];
  const recent = (b: HibpBreach) => !!b.breachDate && now.getTime() - new Date(b.breachDate).getTime() < 2 * 365 * DAY;
  const sev = (b: HibpBreach): PostureSeverity => (recent(b) ? (b.dataClasses.some((c) => /password/i.test(c)) ? 'high' : 'medium') : 'low');
  const worst = hits.map(sev).sort((a, b) => SEV_RANK[b] - SEV_RANK[a])[0];
  hits.sort((a, b) => String(b.breachDate).localeCompare(String(a.breachDate)));
  return [{
    id: 'hibp-site-breach',
    severity: worst,
    category: 'exposure',
    title: `Have I Been Pwned lists ${plural(hits.length, 'breach', 'breaches')} of a site on your domains`,
    why: "The site's user data was taken and is circulating. Anyone with an account there should assume the listed data is public; reused passwords are the main risk.",
    fix: 'Make sure the hole is closed, reset the affected accounts\' passwords (and anywhere they reused them), and tell the users if you haven\'t already. Snooze this once that\'s done; it comes back only if a new breach is listed.',
    affected: hits.map((b) => ({
      label: `${b.title} (${b.domain})`,
      url: `https://haveibeenpwned.com/PwnedWebsites#${encodeURIComponent(b.name)}`,
      note: [b.breachDate && `breached ${b.breachDate}`, b.pwnCount != null && `${b.pwnCount.toLocaleString('en-US')} accounts`, b.dataClasses.slice(0, 5).join(', ')].filter(Boolean).join(' · '),
    })),
    source: 'Have I Been Pwned',
  }];
}


// ── NPM access lists and public DNS (shared with exposure paths) ───────────

const PRIVATE_V4: [number, number][] = [[0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16], [0x7f000000, 8], [0x64400000, 10], [0xa9fe0000, 16]];
/** Is this access-list address (IP or CIDR) inside private / local space? */
export function isPrivateAddr(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  if (/^(fd|fc|fe80|::1)/.test(a)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(a);
  if (!m) return false;
  const ip = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
  const len = m[5] != null ? +m[5] : 32;
  return PRIVATE_V4.some(([net, bits]) => len >= bits && ((ip >>> (32 - bits)) << (32 - bits)) >>> 0 === net);
}

/** What a proxy host's NPM access list does: LAN only, a password login, an IP allow-list, or unknown. */
export function npmAcl(lists: ConnectorResource[] | undefined, p: ConnectorResource): { name: string | null; kind: 'lan' | 'login' | 'ip' | 'unknown' | 'none' } {
  const raw = str(p.details?.access_list);
  if (!raw || /^public$/i.test(raw)) return { name: null, kind: 'none' };
  const ref = raw.replace(/^#/, '');
  const l = (lists ?? []).find((x) => x.id === ref || x.name === raw);
  if (!l) return { name: `#${ref}`, kind: 'unknown' };
  const users = Number(l.details?.auth_users ?? 0);
  const rules = (str(l.details?.clients) ?? '').split(',').map((r) => r.trim()).filter(Boolean).map((r) => { const [d, ...a] = r.split(/\s+/); return { allow: d.toLowerCase() === 'allow', addr: a.join(' ') }; });
  const allows = rules.filter((r) => r.allow);
  const satisfyAny = /^any$/i.test(str(l.details?.satisfy) ?? '');
  // NPM denies everyone else once there's an allow rule. "Satisfy any" + a login lets a password in from anywhere.
  if (allows.length && allows.every((r) => r.addr !== 'all' && isPrivateAddr(r.addr)) && !(satisfyAny && users > 0)) return { name: l.name, kind: 'lan' };
  if (users > 0) return { name: l.name, kind: 'login' };
  if (Number(l.details?.client_rules ?? 0) > 0) return { name: l.name, kind: 'ip' };
  return { name: l.name, kind: 'unknown' };
}

/** Does this name have a public DNS record? "unknown" when its zone isn't in a Cloudflare connector. */
export function publicDnsState(input: BuildInput, name: string): 'listed' | 'unlisted' | 'unknown' {
  const pd = input.publicDns;
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (!pd) return 'unknown';
  const zone = pd.zones.find((z) => n === z || n.endsWith(`.${z}`));
  // Not a Cloudflare zone: use what public resolvers said, if they answered.
  if (!zone) return pd.resolved?.[n] === true ? 'listed' : pd.resolved?.[n] === false ? 'unlisted' : 'unknown';
  const names = new Set(pd.names.map((x) => x.toLowerCase().replace(/\.$/, '')));
  if (names.has(n)) return 'listed';
  const parent = n.slice(n.indexOf('.') + 1);
  if (n !== zone && names.has(`*.${parent}`)) return 'listed';
  return 'unlisted';
}


/** Per public name served by NPM (dns node id): what guards it, for exposure paths. */
export function npmNameGuards(input: BuildInput): Map<string, { lan: boolean; marked?: boolean; notes: string[] }> {
  const out = new Map<string, { lan: boolean; marked?: boolean; notes: string[] }>();
  const marked = new Set((input.internalNames ?? []).map((x) => x.toLowerCase()));
  for (const n of input.npm)
    for (const p of n.proxyHosts) {
      const a = npmAcl(n.accessLists, p);
      const ssl = !/^off$/i.test(str(p.details?.ssl) ?? '');
      const notes = [
        a.kind === 'login' ? `password login (${a.name})` : a.kind === 'ip' ? `IP allow-list (${a.name})` : a.kind === 'unknown' && a.name ? `access list ${a.name}` : a.kind === 'none' ? 'no access list' : null,
        ssl ? null : 'plain HTTP',
        publicDnsState(input, p.name) === 'unlisted' ? (a.kind === 'ip' ? 'not in public DNS' : 'not in public DNS (reachable if someone knows the name)') : null,
      ].filter((x): x is string => !!x);
      for (const name of (str(p.details?.domains) ?? p.name).split(/[,\s]+/).filter(Boolean)) {
        const m = marked.has(name.toLowerCase());
        out.set(`dns:${name.toLowerCase()}`, { lan: a.kind === 'lan' || m, marked: m && a.kind !== 'lan', notes });
      }
    }
  // Tunnel names you marked internal.
  for (const n of marked) if (!out.has(`dns:${n}`)) out.set(`dns:${n}`, { lan: true, marked: true, notes: [] });
  return out;
}

/** What still names an address nobody has seen: firewall rules (and groups), DNS records, forwards. */
function usedBy(graph: TopologyGraph, n: TopoNode): string {
  const byId = new Map(graph.nodes.map((x) => [x.id, x]));
  const refs: string[] = [];
  for (const e of graph.edges) {
    if (e.source !== n.id && e.target !== n.id) continue;
    const other = byId.get(e.source === n.id ? e.target : e.source);
    if (e.type === 'fw_allow' || e.type === 'fw_block') refs.push(...(e.notes ?? []).map((x) => `rule ${x}`));
    else if (e.type === 'resolves' && other?.type === 'dns_name') refs.push(`DNS ${other.label}`);
    else if (e.notes?.length) refs.push(...e.notes);
    else if (other) refs.push(other.label);
  }
  for (const d of n.details) if (d.source === 'Named by') refs.push(...d.items.map((i) => `rule ${i.value}`));
  const uniq = [...new Set(refs)];
  const shown = uniq.slice(0, 3).join('; ') + (uniq.length > 3 ? `; +${uniq.length - 3} more` : '');
  const outside = n.parent ? '' : 'outside your networks';
  return [shown ? `Named by ${shown}` : '', outside].filter(Boolean).join(' · ');
}

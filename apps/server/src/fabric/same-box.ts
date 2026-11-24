/**
 * Same-box detection (docs/health-monitoring.md → "Waypoint and agent on one machine").
 *
 * A Waypoint and an endpoint agent can run side by side on one machine (separate
 * services, config dirs and credentials). Both run the health and OS-update
 * modules, so without this the machine shows twice on Health, alerts twice and
 * is offered twice for installs. When an endpoint agent is found on the same box,
 * the Waypoint *defers* to it: its health is hidden and switched off, and it is
 * left out of OS updates. A Waypoint with no endpoint agent beside it keeps
 * reporting as before.
 *
 * "Same box" needs BOTH signals, never a name alone:
 *  - the same OS hostname (case-insensitive, domain stripped), and
 *  - at least one shared physical MAC (globally unique: not locally administered,
 *    not multicast — random / virtual MACs never count).
 * Pure functions only; SameBoxService holds the cached result.
 */

export interface SameBoxAgent {
  id: string;
  name: string;
  /** "endpoint" | "waypoint" */
  mode: string;
  /** Agent.hostname (reported on hello). */
  hostname: string | null;
  /** From AgentHealth.inventory. */
  invHostname?: string | null;
  macs?: string[] | null;
  online: boolean;
  lastSeenAt: Date | null;
}

export interface SameBoxPeer {
  agentId: string;
  name: string;
  mode: string;
}

export interface SameBoxResult {
  /** Waypoint agent id → the endpoint agent it defers to. */
  deferring: Map<string, SameBoxPeer>;
  /** Endpoint agent id → the Waypoints on the same box that defer to it. */
  companions: Map<string, SameBoxPeer[]>;
}

/**
 * How long an endpoint agent may be silent while its Waypoint is still online
 * before the Waypoint takes health back (so the box is never left unmonitored
 * because only the endpoint service died).
 */
export const ENDPOINT_SILENCE_MS = 60 * 60_000;

/** "Rockingroller.lan" → "rockingroller". Empty when there's nothing usable. */
export function normHostname(h: string | null | undefined): string {
  return (h ?? '').trim().toLowerCase().split('.')[0].replace(/[^a-z0-9-]/g, '');
}

/** Lower-cased colon form for a globally-unique unicast MAC, else null. */
export function physicalMac(raw: string): string | null {
  const m = raw.trim().toLowerCase().replace(/-/g, ':');
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(m)) return null;
  if (m === '00:00:00:00:00:00') return null;
  const first = parseInt(m.slice(0, 2), 16);
  if (first & 0x01) return null; // multicast
  if (first & 0x02) return null; // locally administered (random / virtual)
  return m;
}

function macSet(a: SameBoxAgent): Set<string> {
  const out = new Set<string>();
  for (const raw of a.macs ?? []) {
    const m = typeof raw === 'string' ? physicalMac(raw) : null;
    if (m) out.add(m);
  }
  return out;
}

function hostOf(a: SameBoxAgent): string {
  return normHostname(a.invHostname) || normHostname(a.hostname);
}

/** Pair each Waypoint with the endpoint agent on the same machine, if there is one. */
export function computeSameBox(agents: SameBoxAgent[], now = Date.now()): SameBoxResult {
  const deferring = new Map<string, SameBoxPeer>();
  const companions = new Map<string, SameBoxPeer[]>();
  const endpoints = agents
    .filter((a) => a.mode !== 'waypoint')
    .map((a) => ({ a, host: hostOf(a), macs: macSet(a) }))
    .filter((e) => e.host && e.macs.size > 0);

  for (const w of agents) {
    if (w.mode !== 'waypoint') continue;
    const host = hostOf(w);
    const macs = macSet(w);
    if (!host || !macs.size) continue;
    const matches = endpoints.filter((e) => e.host === host && [...e.macs].some((m) => macs.has(m)));
    if (!matches.length) continue;
    // Several endpoint rows for one box (e.g. a leftover from a re-install): the
    // one seen most recently is the live one.
    matches.sort((x, y) => Number(y.a.online) - Number(x.a.online) || (y.a.lastSeenAt?.getTime() ?? 0) - (x.a.lastSeenAt?.getTime() ?? 0));
    const e = matches[0].a;
    // The endpoint service is down but the Waypoint is up: let the Waypoint report.
    const silentFor = e.online ? 0 : now - (e.lastSeenAt?.getTime() ?? 0);
    if (w.online && silentFor > ENDPOINT_SILENCE_MS) continue;
    deferring.set(w.id, { agentId: e.id, name: e.name, mode: e.mode });
    const list = companions.get(e.id) ?? [];
    list.push({ agentId: w.id, name: w.name, mode: w.mode });
    companions.set(e.id, list);
  }
  return { deferring, companions };
}

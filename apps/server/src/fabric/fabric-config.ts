import { FABRIC_HEARTBEAT_MS, FABRIC_MISSED_BEATS_OFFLINE } from '@cerebro/shared';

/** Parse a positive-integer env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Operator-tunable Fabric cadences (env-driven). Raise these when many agents are
 * enrolled to cut steady-state load: `FABRIC_HEARTBEAT_MS` reduces the per-agent
 * liveness DB writes (agents adopt it on their next hello), and `FABRIC_POLL_MS`
 * slows how often the /fabric screen refreshes the agent list.
 */
export const fabricConfig = {
  /** Heartbeat cadence sent to agents; also drives the offline timeout window. */
  get heartbeatMs(): number {
    return envInt('FABRIC_HEARTBEAT_MS', FABRIC_HEARTBEAT_MS);
  },
  /** Consecutive missed heartbeats before an agent is marked offline. */
  get missedBeatsOffline(): number {
    return envInt('FABRIC_MISSED_BEATS_OFFLINE', FABRIC_MISSED_BEATS_OFFLINE);
  },
  /** How long a stale-but-online agent may go unseen before the reconciler
   *  marks it offline: the missed-beats window plus a fixed reconnect buffer. */
  get reconcileGraceMs(): number {
    return this.heartbeatMs * (this.missedBeatsOffline + 1) + 30_000;
  },
  /** How often the web /fabric screen polls the agent list. */
  get pollMs(): number {
    return envInt('FABRIC_POLL_MS', 10_000);
  },
  /** Lifetime (minutes) of an SSH CA user certificate. Short by design. */
  get caTtlMinutes(): number {
    return envInt('FABRIC_CA_TTL_MINUTES', 5);
  },
};

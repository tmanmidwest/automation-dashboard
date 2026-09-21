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
  /**
   * Grace period after a control connection drops before the agent is actually
   * marked offline + alerted. Agents reconnect in ~1–6s after an upstream proxy
   * recycles the WebSocket, so this debounce swallows those blips (no status
   * flicker, no false "offline" email) while still alerting on a real outage.
   */
  get offlineGraceMs(): number {
    return envInt('FABRIC_OFFLINE_GRACE_MS', 60_000);
  },
  /** How long a stale-but-online agent may go unseen before the reconciler
   *  marks it offline: the larger of the missed-beats window and the offline
   *  grace, plus a fixed reconnect buffer (so the reconciler never beats the
   *  connection-drop debounce). */
  get reconcileGraceMs(): number {
    return Math.max(this.heartbeatMs * (this.missedBeatsOffline + 1), this.offlineGraceMs) + 30_000;
  },
  /** How often the web /fabric screen polls the agent list. */
  get pollMs(): number {
    return envInt('FABRIC_POLL_MS', 10_000);
  },
  /** Lifetime (minutes) of an SSH CA user certificate. Short by design. */
  get caTtlMinutes(): number {
    return envInt('FABRIC_CA_TTL_MINUTES', 5);
  },
  /** Lifetime (weeks) of an SSH host certificate — long; renewed on re-trust. */
  get caHostTtlWeeks(): number {
    return envInt('FABRIC_CA_HOST_TTL_WEEKS', 26);
  },
};

/**
 * Numeric "alert when a metric crosses a limit" definitions. Each maps an
 * overview metric (by key) to an alert type, and to a per-connector threshold
 * stored under `notify.connector.<id>.threshold.<id>`. Add an entry here to make
 * a new metric threshold-able (e.g. CPU %, memory %) — the monitor, the settings
 * API, and the connector UI all read from this list.
 */
export interface MetricThresholdDef {
  /** Stable id, also the per-connector setting suffix, e.g. 'cost'. */
  id: string;
  /** The overview metric key to watch, e.g. 'costMtd'. */
  metricKey: string;
  /** The alert type raised when the threshold is crossed. */
  alertKey: string;
  /** Human label for messages, e.g. 'Monthly cost'. */
  label: string;
}

export const METRIC_THRESHOLDS: MetricThresholdDef[] = [
  { id: 'cost', metricKey: 'costMtd', alertKey: 'cost.threshold', label: 'Monthly cost' },
  { id: 'storage', metricKey: 'repoSizeGb', alertKey: 'storage.threshold', label: 'Repository size' },
  // Home Assistant health (counts from the connector's /api/states overview).
  { id: 'haUnavailable', metricKey: 'entitiesUnavailable', alertKey: 'ha.unavailable', label: 'Unavailable entities' },
  { id: 'haBatteries', metricKey: 'batteriesLow', alertKey: 'ha.batteries_low', label: 'Low batteries' },
  { id: 'haUpdates', metricKey: 'updatesAvailable', alertKey: 'ha.updates', label: 'Updates available' },
  { id: 'haAutomationsOff', metricKey: 'automationsOff', alertKey: 'ha.automations_off', label: 'Automations off' },
  { id: 'haIntegrations', metricKey: 'integrationsDegraded', alertKey: 'ha.integrations', label: 'Degraded integrations' },
  // Cloudflare health (counts from the connector's overview).
  { id: 'cfTunnelsDown', metricKey: 'tunnelsDown', alertKey: 'cloudflare.tunnels_down', label: 'Tunnels down' },
  { id: 'cfZonesPaused', metricKey: 'zonesPaused', alertKey: 'cloudflare.zones_paused', label: 'Zones paused' },
  { id: 'cfCertsExpiring', metricKey: 'certsExpiringSoon', alertKey: 'cloudflare.certs_expiring', label: 'Certificates expiring' },
  { id: 'cfTokensExpiring', metricKey: 'tokensExpiringSoon', alertKey: 'cloudflare.tokens_expiring', label: 'Service tokens expiring' },
  { id: 'cfThreats', metricKey: 'threats24h', alertKey: 'cloudflare.threats', label: 'Threats (24h)' },
  // Docker health (counts from the connector's overview).
  { id: 'dockerUnhealthy', metricKey: 'containersUnhealthy', alertKey: 'docker.unhealthy', label: 'Unhealthy containers' },
  { id: 'dockerStopped', metricKey: 'containersStopped', alertKey: 'docker.stopped', label: 'Stopped containers' },
  { id: 'dockerDisk', metricKey: 'diskUsedGb', alertKey: 'docker.disk_high', label: 'Docker disk used' },
  { id: 'dockerRestarting', metricKey: 'containersRestarting', alertKey: 'docker.restart_loop', label: 'Restarting containers' },
  { id: 'dockerUpdates', metricKey: 'updatesAvailable', alertKey: 'docker.updates_available', label: 'Image updates available' },
  { id: 'dockerHostDisk', metricKey: 'hostRootDiskPct', alertKey: 'docker.host_disk', label: 'Host root disk used' },
  { id: 'dockerHostMem', metricKey: 'hostMemUsedPct', alertKey: 'docker.host_mem', label: 'Host memory used' },
  { id: 'dockerHostLoad', metricKey: 'hostLoadPct', alertKey: 'docker.host_load', label: 'Host CPU load' },
];

export function thresholdByAlertKey(alertKey: string): MetricThresholdDef | undefined {
  return METRIC_THRESHOLDS.find((t) => t.alertKey === alertKey);
}

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
];

export function thresholdByAlertKey(alertKey: string): MetricThresholdDef | undefined {
  return METRIC_THRESHOLDS.find((t) => t.alertKey === alertKey);
}

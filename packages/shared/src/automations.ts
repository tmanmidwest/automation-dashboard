// Automations engine — rules: when <trigger> [if <conditions>] do <actions>.
// See docs/automations.md.

export type AutomationSeverity = 'info' | 'warning' | 'critical';

/** The "when": an event on the timeline bus, or a schedule. */
export type RuleTrigger =
  | {
      type: 'event';
      /** Match these timeline event kinds (audit | app_log | notification | job | monitor). Empty = any. */
      kinds?: string[];
      /** Match these severities (info | success | warning | critical). Empty = any. */
      severities?: string[];
      /** Substring match against the event source (connectorId / monitor id / 'auth'). */
      source?: string;
      /** Case-insensitive substring match against the event title/detail. */
      textContains?: string;
    }
  | { type: 'schedule'; cron: string };

/** The "if": all conditions must hold (AND). */
export type RuleCondition =
  | { type: 'time_window'; start: string; end: string } // "HH:MM".."HH:MM", server-local; wraps past midnight
  | { type: 'severity_at_least'; severity: AutomationSeverity };

/** The "do": actions run in order. */
export type RuleAction =
  | { type: 'notify'; title: string; body?: string; severity?: AutomationSeverity }
  | { type: 'connector_action'; instanceId: string; kind: string; resourceId: string; actionId: string }
  | { type: 'connector_operation'; instanceId: string; operationId: string; resourceId?: string; values?: Record<string, unknown> };

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Don't re-fire within this window. */
  cooldownSec: number;
  lastFiredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when creating/updating a rule. */
export interface AutomationRuleInput {
  name: string;
  enabled?: boolean;
  trigger: RuleTrigger;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
  cooldownSec?: number;
}

export type AutomationRunStatus = 'success' | 'partial' | 'error' | 'skipped';

export interface AutomationRun {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: string;
  status: AutomationRunStatus;
  message?: string | null;
  createdAt: string;
}

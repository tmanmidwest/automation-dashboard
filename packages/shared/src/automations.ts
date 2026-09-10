// Automations engine — rules: when <trigger> [if <conditions>] do <actions>.
// See docs/automations.md.

export type AutomationSeverity = 'info' | 'warning' | 'critical';

/** Debounce/flap qualifier: fire only after `count` matching events within `windowSec`. */
export interface RuleOccurrences {
  count: number;
  windowSec: number;
}

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
      /** Debounce: only fire once `count` matching events arrive within `windowSec` (flap suppression). */
      occurrences?: RuleOccurrences;
    }
  | { type: 'schedule'; cron: string };

/** Comparison operators for a meta_threshold condition. */
export type ThresholdOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

/** The "if": all conditions must hold (AND). */
export type RuleCondition =
  | { type: 'time_window'; start: string; end: string } // "HH:MM".."HH:MM", server-local; wraps past midnight
  | { type: 'severity_at_least'; severity: AutomationSeverity }
  /** Compare a value pulled from the event's `meta` (dotted path) against a number/string. */
  | { type: 'meta_threshold'; path: string; op: ThresholdOp; value: number | string }
  /** Cross-check: a named monitor is currently in this state (up | down | paused). */
  | { type: 'monitor_state'; monitorId: string; state: 'up' | 'down' | 'paused' };

/** The "do": actions run in order. */
export type RuleAction =
  | { type: 'notify'; title: string; body?: string; severity?: AutomationSeverity }
  | { type: 'connector_action'; instanceId: string; kind: string; resourceId: string; actionId: string }
  | { type: 'connector_operation'; instanceId: string; operationId: string; resourceId?: string; values?: Record<string, unknown> }
  /** Pause a monitor (stop probing). */
  | { type: 'pause_monitor'; monitorId: string }
  /** Resume a paused monitor. */
  | { type: 'resume_monitor'; monitorId: string }
  /** POST/GET an outbound webhook. `body` supports {{title}} {{severity}} {{source}} {{detail}} {{kind}} {{ruleName}} tokens. */
  | { type: 'webhook'; url: string; method?: 'GET' | 'POST'; body?: string }
  /** Ask the Computer (in-app LLM) headlessly — it runs read-only tools, produces a
   *  short answer grounded in the triggering event, and delivers it as a notification. */
  | { type: 'ask_computer'; prompt: string; title?: string; severity?: AutomationSeverity };

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

# Automations engine (rules: when → if → do)

Design + implementation plan for a **rules engine** that ties Cerebro's existing pieces together:
*when* something happens, *if* some condition holds, *do* one or more actions — across connectors.
It turns Cerebro from a dashboard with manual buttons into a **control plane**. The engine invents
almost nothing: the triggers, conditions, and actions are all things Cerebro already produces.

## The three parts, and where they come from

- **Triggers (the "when")** — Cerebro already emits these onto the **timeline event bus**
  (`TimelineBus`, built for the Ship's Log live tail). Every alert dispatch, audit event, job
  outcome, and warn/error log flows through it as a normalized `TimelineEvent`
  (`{ kind, severity, source, title, detail, actor, meta }`). A monitor going down, a container
  turning unhealthy, a backup failing, a Cloudflare tunnel dropping — all arrive here as
  notification/audit events. Plus a **schedule** trigger (cron) for time-based rules.
- **Conditions (the "if")** — refine a trigger: a time-of-day window, a minimum severity, a
  specific connector/source, a text match. (MVP keeps these light; the trigger filter does most of
  the work.)
- **Actions (the "do")** — the things Cerebro can already do:
  - **notify** — send a notification (email/SMS/Signal) via `NotificationsService`.
  - **connector action** — `performAction(instanceId, kind, resourceId, actionId)` (start/stop a
    VM, restart a container/stack, …).
  - **connector operation** — `startOperation(instanceId, operationId, resourceId, values)` (deploy
    a stack, run a backup, …).
  - *(later)* pause/resume a monitor, run an MCP tool.

## Model

```ts
interface AutomationRule {
  id: string; name: string; enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];   // ALL must hold (AND)
  actions: RuleAction[];         // run in order
  cooldownSec: number;           // don't re-fire within this window (loop/spam guard)
}

type RuleTrigger =
  | { type: 'event'; kinds?: string[]; severities?: string[]; source?: string; textContains?: string }
  | { type: 'schedule'; cron: string };   // 5-field cron

type RuleCondition =
  | { type: 'time_window'; start: string; end: string }   // "22:00".."06:00", local
  | { type: 'severity_at_least'; severity: 'info'|'warning'|'critical' };

type RuleAction =
  | { type: 'notify'; title: string; body?: string; severity?: 'info'|'warning'|'critical' }
  | { type: 'connector_action'; instanceId: string; kind: string; resourceId: string; actionId: string }
  | { type: 'connector_operation'; instanceId: string; operationId: string; resourceId?: string; values?: Record<string,unknown> };
```

**How it evaluates:** the engine subscribes to `TimelineBus.stream({})` (all events). For each
event, it finds enabled `event` rules whose trigger matches, checks the conditions, honours the
**cooldown**, then executes the actions in order — recording an `AutomationRun`. A separate
**@Cron** tick fires `schedule` rules. Every run is audited, so automations show up in the very
timeline that (often) triggered them.

## Safety

- **Cooldown** per rule (default 60s) so a rule can't re-fire in a tight loop, and so a burst of
  identical events doesn't spam.
- **Loop guard** — an action produces events (e.g. a `connector.action` audit event) that could
  match another rule; the cooldown plus a per-evaluation depth cap contain runaway chains.
- **Rules never fire themselves** — the engine ignores events whose source is the automations
  engine itself.
- **Dry-run / test** — a `POST /api/automations/:id/test` runs a rule's actions on demand (for
  building/verifying) without waiting for a trigger, tagged as a test run.
- **Permissioned + audited** — new `automations:read` / `automations:write` RBAC (admin only, never
  a bearer-token scope, since a rule can run infra actions). Every automation run writes an audit
  event.

## Schema (Prisma)

```prisma
model AutomationRule {
  id          String   @id @default(cuid())
  name        String
  enabled     Boolean  @default(true)
  trigger     Json
  conditions  Json     @default("[]")
  actions     Json     @default("[]")
  cooldownSec Int      @default(60)
  lastFiredAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model AutomationRun {
  id          String   @id @default(cuid())
  ruleId      String
  ruleName    String
  trigger     String            // short description of what fired it
  status      String            // success | partial | error | skipped
  message     String?
  createdAt   DateTime @default(now())
  @@index([ruleId, createdAt])
  @@index([createdAt])
}
```

---

## Phase 1 — The engine (backend) — this pass

- `AutomationsModule` importing `ConnectorsModule` (for `ConnectorInstanceService`) and
  `NotificationsModule`; `TimelineBus` comes from the global logging module.
- `AutomationsService`: rule CRUD; a `TimelineBus` subscription that evaluates `event` rules; an
  `@Cron(EVERY_MINUTE)` that evaluates `schedule` rules; an executor for the three action types;
  cooldown + loop guard; run recording + audit.
- `AutomationsController`: `GET/POST/PUT/DELETE /api/automations`, `GET /api/automations/runs`,
  `POST /api/automations/:id/test`. Gated by `automations:read` / `automations:write`.
- Shared types in `packages/shared/src/automations.ts`; RBAC additions.

**Deliverable:** a working rules engine, testable end-to-end via the API/MCP — e.g. "when a
`monitor.down` notification fires → notify me + restart the container."

## Phase 2 — Rule builder UI

A `/automations` screen: list rules (enabled toggle, last fired), a builder (trigger picker →
conditions → action rows, with connector/kind/resource/action dropdowns reusing the existing
options endpoints), and a run history. Nav entry + route.

## Phase 3 — Richer triggers/conditions/actions ✅ built

Shipped:

- **Conditions**
  - `meta_threshold` — pull a value from the event's `meta` by dotted path (e.g. `cpu.usage`) and
    compare with `> >= < <= == !=` against a number or string. Missing value ⇒ condition fails.
  - `monitor_state` — cross-check: a named monitor is currently `up | down | paused` (reads
    `Monitor.status`). Works for both event and schedule triggers.
- **Actions**
  - `pause_monitor` / `resume_monitor` — via `MonitorsService.setEnabled` (flips status + scheduler).
  - `webhook` — outbound `POST`/`GET` to any http(s) URL, 10s timeout. `POST` body supports
    `{{title}} {{severity}} {{source}} {{detail}} {{kind}} {{ruleName}}` tokens rendered from the
    triggering event (good for Slack/Discord/generic hooks).
- **Trigger qualifier — debounce/flap suppression**: an event trigger can require `count` matching
  events within `windowSec` before it fires (per-rule sliding window in memory; resets after firing).
  Replaces the vaguer "for N minutes" idea with a concrete, testable "N occurrences in M seconds".

Engine notes: condition evaluation is now async (`holds()`) because `monitor_state` queries live
state; the triggering `TimelineEvent` is threaded into `fire → runAction` for webhook templating.
`AutomationsModule` now imports `MonitorsModule`. Controller validates the new actions (monitor id
required; webhook needs an http(s) URL). Not yet built: run-an-MCP-tool action (connector
action/operation already cover "do something on a connector").

## Files touched (Phase 1)

| File | Change |
| --- | --- |
| `apps/server/prisma/schema.prisma` (+ migration) | `AutomationRule`, `AutomationRun` |
| `packages/shared/src/automations.ts` (new) + `index.ts` | rule/trigger/condition/action types |
| `packages/shared/src/rbac.ts` | `automations:read` / `automations:write` (admin; not token scopes) |
| `apps/server/src/automations/*` (new module) | service + controller + module |
| `apps/server/src/app.module.ts` | register `AutomationsModule` |
| `apps/server/src/notifications/alerts/alert-registry.ts` | an `automation.notify` alert type for the notify action |

## Open questions

1. **Trigger surface** — the MVP triggers off the timeline event bus (alerts/audit/logs), which
   already carries the meaningful events. If a needed trigger isn't on the bus (e.g. a raw monitor
   transition distinct from its alert), publish it to the bus rather than adding a second stream.
2. **Notify action vs alert catalog** — the `notify` action dispatches a dedicated
   `automation.notify` alert type (so it flows through the existing channel routing/history) rather
   than a bespoke send path.
3. **Multi-instance** — the engine subscribes in-process (single-instance deployment). Multi-replica
   would need one owner or Redis coordination, same caveat as the live tail.

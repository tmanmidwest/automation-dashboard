import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Play, Pencil, Zap } from 'lucide-react';
import type {
  AutomationRule, AutomationRuleInput, AutomationRun,
  ConnectorInstanceSummary, ConnectorManifest, ConnectorOperation, ConnectorResource,
  MonitorSummary, RuleAction, RuleCondition, RuleTrigger,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/auth/AuthContext';
import { PageHeader } from '@/components/PageHeader';
import { OperationFields } from '@/components/OperationFields';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Local mirrors (web imports types only from shared).
const EVENT_KINDS: { id: string; label: string }[] = [
  { id: 'notification', label: 'Alert' }, { id: 'audit', label: 'Audit' },
  { id: 'monitor', label: 'Monitor' }, { id: 'job', label: 'Job' }, { id: 'app_log', label: 'System log' },
];
const EVENT_SEVERITIES = ['info', 'success', 'warning', 'critical'];
const COND_SEVERITIES = ['info', 'warning', 'critical'];
const THRESHOLD_OPS = ['>', '>=', '<', '<=', '==', '!='];
const MONITOR_STATES = ['up', 'down', 'paused'];
const RUN_COLOR: Record<string, string> = {
  success: 'text-emerald-400', partial: 'text-amber-400', error: 'text-destructive', skipped: 'text-muted-foreground',
};

const selectCls = 'mt-1 w-full h-9 rounded-md border border-input bg-background/60 px-2 text-sm';

function blankRule(): AutomationRuleInput {
  return { name: '', enabled: true, trigger: { type: 'event' }, conditions: [], actions: [], cooldownSec: 60 };
}

function triggerSummary(t: RuleTrigger): string {
  if (t.type === 'schedule') return `Schedule · ${t.cron}`;
  const bits = [t.kinds?.length ? t.kinds.join('/') : 'any event', t.severities?.length ? `[${t.severities.join(',')}]` : '', t.source ? `from ${t.source}` : '', t.textContains ? `“${t.textContains}”` : ''];
  return bits.filter(Boolean).join(' ');
}

export function Automations() {
  const { can } = useAuth();
  const canWrite = can('automations:write');

  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInstanceSummary[]>([]);
  const [monitors, setMonitors] = useState<MonitorSummary[]>([]);
  const [manifests, setManifests] = useState<Record<string, ConnectorManifest>>({});
  const [err, setErr] = useState<string | null>(null);

  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null);
  const [form, setForm] = useState<AutomationRuleInput>(blankRule());
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [r, ru, c, m] = await Promise.all([
        api.get<AutomationRule[]>('/api/automations'),
        api.get<AutomationRun[]>('/api/automations/runs?limit=50'),
        api.get<ConnectorInstanceSummary[]>('/api/connectors/instances').catch(() => []),
        api.get<MonitorSummary[]>('/api/monitors').catch(() => []),
      ]);
      setRules(r); setRuns(ru); setConnectors(c); setMonitors(m);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed to load'); }
  }
  useEffect(() => { load(); }, []);

  async function loadManifest(connectorId: string) {
    if (manifests[connectorId]) return manifests[connectorId];
    const m = await api.get<ConnectorManifest>(`/api/connectors/available/${connectorId}`).catch(() => null);
    if (m) setManifests((prev) => ({ ...prev, [connectorId]: m }));
    return m;
  }

  function openNew() { setForm(blankRule()); setEditing('new'); setErr(null); }
  function openEdit(r: AutomationRule) {
    setForm({ name: r.name, enabled: r.enabled, trigger: r.trigger, conditions: r.conditions, actions: r.actions, cooldownSec: r.cooldownSec });
    setEditing(r); setErr(null);
    // Warm manifests for any connector actions.
    for (const a of r.actions) if (a.type === 'connector_action' || a.type === 'connector_operation') void loadManifest(connectors.find((c) => c.id === a.instanceId)?.connectorId ?? '');
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (editing === 'new') await api.post('/api/automations', form);
      else if (editing) await api.put(`/api/automations/${editing.id}`, form);
      setEditing(null); await load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  async function toggle(r: AutomationRule) {
    try { await api.put(`/api/automations/${r.id}`, { enabled: !r.enabled }); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  }
  async function remove(r: AutomationRule) {
    if (!confirm(`Delete rule "${r.name}"?`)) return;
    try { await api.delete(`/api/automations/${r.id}`); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Failed'); }
  }
  async function test(r: AutomationRule) {
    try { const res = await api.post<{ status: string; message: string }>(`/api/automations/${r.id}/test`, {}); alert(`Test → ${res.status}\n${res.message}`); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Test failed'); }
  }

  return (
    <>
      <PageHeader title="Automations" description="Rules that react to events and act across your connectors."
        actions={canWrite ? <Button onClick={openNew}><Plus className="h-4 w-4" /> New rule</Button> : undefined} />

      {err && !editing && (
        <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>
      )}

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-base">Rules</CardTitle>
          <CardDescription>When a trigger matches, the rule's actions run in order (respecting its cooldown).</CardDescription></CardHeader>
        <CardContent>
          {rules === null ? <div className="py-6 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></div>
            : rules.length === 0 ? <p className="text-sm text-muted-foreground">No rules yet. Create one to react to an event or schedule.</p>
            : (
            <div className="divide-y divide-border">
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-3">
                  <button onClick={() => canWrite && toggle(r)} disabled={!canWrite}
                    className={cn('h-5 w-9 rounded-full relative transition-colors shrink-0', r.enabled ? 'bg-primary' : 'bg-muted')}
                    aria-label={r.enabled ? 'Disable' : 'Enable'}>
                    <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', r.enabled ? 'left-4' : 'left-0.5')} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{r.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {triggerSummary(r.trigger)} → {r.actions.length} action{r.actions.length !== 1 ? 's' : ''}
                      {r.lastFiredAt && ` · last fired ${new Date(r.lastFiredAt).toLocaleString()}`}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" onClick={() => test(r)} aria-label="Test"><Play className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => openEdit(r)} aria-label="Edit"><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" onClick={() => remove(r)} aria-label="Delete"><Trash2 className="h-4 w-4 text-destructive" /></Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent runs</CardTitle></CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? <p className="text-sm text-muted-foreground px-6 pb-4">No runs yet.</p> : (
            <div className="divide-y divide-border/50 text-sm">
              {runs.map((run) => (
                <div key={run.id} className="flex items-start gap-3 px-6 py-2">
                  <span className="text-muted-foreground w-36 shrink-0 text-xs tabular-nums pt-0.5">{new Date(run.createdAt).toLocaleString()}</span>
                  <span className={cn('w-16 shrink-0 text-xs uppercase font-semibold pt-0.5', RUN_COLOR[run.status])}>{run.status}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{run.ruleName}</p>
                    <p className="text-xs text-muted-foreground break-words">{run.trigger}{run.message ? ` — ${run.message}` : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!editing} onClose={() => setEditing(null)} size="lg"
        title={editing === 'new' ? 'New rule' : `Edit rule`}
        description="When the trigger matches and the conditions hold, the actions run in order."
        footer={<>
          <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
          <Button onClick={save} disabled={busy || !form.name.trim() || (form.actions ?? []).length === 0}>{busy ? 'Saving…' : 'Save rule'}</Button>
        </>}>
        {err && <div className="mb-4 text-sm rounded-md px-3 py-2 border border-destructive/40 bg-destructive/10 text-destructive">{err}</div>}
        <RuleEditor form={form} setForm={setForm} connectors={connectors} monitors={monitors} manifests={manifests} loadManifest={loadManifest} />
      </Dialog>
    </>
  );
}

// ── Rule editor ───────────────────────────────────────────────────

function RuleEditor({ form, setForm, connectors, monitors, manifests, loadManifest }: {
  form: AutomationRuleInput;
  setForm: (f: AutomationRuleInput) => void;
  connectors: ConnectorInstanceSummary[];
  monitors: MonitorSummary[];
  manifests: Record<string, ConnectorManifest>;
  loadManifest: (connectorId: string) => Promise<ConnectorManifest | null>;
}) {
  const set = (patch: Partial<AutomationRuleInput>) => setForm({ ...form, ...patch });
  const conditions = form.conditions ?? [];
  const actions = form.actions ?? [];
  const toggleIn = (arr: string[] | undefined, v: string): string[] => {
    const s = new Set(arr ?? []); s.has(v) ? s.delete(v) : s.add(v); return [...s];
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div><Label>Name</Label><Input value={form.name} placeholder="Restart unhealthy web stack" onChange={(e) => set({ name: e.target.value })} /></div>
        <div><Label>Cooldown (s)</Label><Input type="number" min={0} className="w-28" value={form.cooldownSec ?? 60} onChange={(e) => set({ cooldownSec: Number(e.target.value) })} /></div>
      </div>

      {/* Trigger */}
      <section>
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">When (trigger)</p>
        <div className="inline-flex rounded-md border border-border overflow-hidden mb-3 text-sm">
          {(['event', 'schedule'] as const).map((t) => (
            <button key={t} type="button" onClick={() => set({ trigger: t === 'event' ? { type: 'event' } : { type: 'schedule', cron: '0 2 * * *' } })}
              className={cn('px-3 py-1', form.trigger.type === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
              {t === 'event' ? 'An event happens' : 'On a schedule'}
            </button>
          ))}
        </div>
        {form.trigger.type === 'event' ? (
          <div className="space-y-3">
            <div>
              <Label>Event kinds <span className="text-muted-foreground font-normal">(any if none checked)</span></Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {EVENT_KINDS.map((k) => {
                  const on = (form.trigger as Extract<RuleTrigger, { type: 'event' }>).kinds?.includes(k.id);
                  return <button key={k.id} type="button" onClick={() => set({ trigger: { ...(form.trigger as object), type: 'event', kinds: toggleIn((form.trigger as Extract<RuleTrigger, { type: 'event' }>).kinds, k.id) } as RuleTrigger })}
                    className={cn('px-2.5 py-1 rounded-full text-xs border', on ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground')}>{k.label}</button>;
                })}
              </div>
            </div>
            <div>
              <Label>Severities <span className="text-muted-foreground font-normal">(any if none checked)</span></Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {EVENT_SEVERITIES.map((s) => {
                  const on = (form.trigger as Extract<RuleTrigger, { type: 'event' }>).severities?.includes(s);
                  return <button key={s} type="button" onClick={() => set({ trigger: { ...(form.trigger as object), type: 'event', severities: toggleIn((form.trigger as Extract<RuleTrigger, { type: 'event' }>).severities, s) } as RuleTrigger })}
                    className={cn('px-2.5 py-1 rounded-full text-xs border capitalize', on ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground')}>{s}</button>;
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Source contains <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input placeholder="a connector id, monitor id…" value={(form.trigger as Extract<RuleTrigger, { type: 'event' }>).source ?? ''}
                  onChange={(e) => set({ trigger: { ...(form.trigger as object), type: 'event', source: e.target.value } as RuleTrigger })} /></div>
              <div><Label>Text contains <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input placeholder="e.g. unhealthy, down, failed" value={(form.trigger as Extract<RuleTrigger, { type: 'event' }>).textContains ?? ''}
                  onChange={(e) => set({ trigger: { ...(form.trigger as object), type: 'event', textContains: e.target.value } as RuleTrigger })} /></div>
            </div>
            <div>
              <Label>Debounce <span className="text-muted-foreground font-normal">(optional — suppress flapping)</span></Label>
              {(() => {
                const et = form.trigger as Extract<RuleTrigger, { type: 'event' }>;
                const occ = et.occurrences;
                const setOcc = (o: { count: number; windowSec: number } | undefined) =>
                  set({ trigger: { ...(form.trigger as object), type: 'event', occurrences: o } as RuleTrigger });
                return occ ? (
                  <div className="flex items-center gap-2 mt-1 text-sm">
                    <span className="text-muted-foreground">Fire only after</span>
                    <Input type="number" min={2} className="w-20" value={occ.count} onChange={(e) => setOcc({ ...occ, count: Number(e.target.value) })} />
                    <span className="text-muted-foreground">matches within</span>
                    <Input type="number" min={1} className="w-24" value={occ.windowSec} onChange={(e) => setOcc({ ...occ, windowSec: Number(e.target.value) })} />
                    <span className="text-muted-foreground">sec</span>
                    <Button type="button" variant="ghost" size="icon" onClick={() => setOcc(undefined)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                ) : (
                  <div className="mt-1"><Button type="button" variant="outline" size="sm" onClick={() => setOcc({ count: 3, windowSec: 300 })}>+ Require repeated matches</Button></div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div><Label>Cron (min hour day month weekday)</Label>
            <Input className="font-mono" placeholder="0 2 * * *" value={(form.trigger as Extract<RuleTrigger, { type: 'schedule' }>).cron}
              onChange={(e) => set({ trigger: { type: 'schedule', cron: e.target.value } })} />
            <p className="text-xs text-muted-foreground mt-1">e.g. <code>0 2 * * *</code> = 02:00 daily · <code>*/15 * * * *</code> = every 15 min</p></div>
        )}
      </section>

      {/* Conditions */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">If (conditions, all must hold)</p>
          <div className="flex flex-wrap gap-1 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conditions, { type: 'time_window', start: '22:00', end: '06:00' }] })}>+ Time window</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conditions, { type: 'severity_at_least', severity: 'warning' }] })}>+ Min severity</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conditions, { type: 'meta_threshold', path: '', op: '>', value: 0 }] })}>+ Meta threshold</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ conditions: [...conditions, { type: 'monitor_state', monitorId: '', state: 'down' }] })}>+ Monitor state</Button>
          </div>
        </div>
        {conditions.length === 0 ? <p className="text-xs text-muted-foreground">No conditions — the trigger alone fires the rule.</p> : (
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border border-border p-2">
                {c.type === 'time_window' ? (
                  <><span className="text-sm text-muted-foreground">Between</span>
                    <Input className="w-24" value={c.start} onChange={(e) => updateCond(conditions, i, { ...c, start: e.target.value }, set)} />
                    <span className="text-sm text-muted-foreground">and</span>
                    <Input className="w-24" value={c.end} onChange={(e) => updateCond(conditions, i, { ...c, end: e.target.value }, set)} /></>
                ) : c.type === 'severity_at_least' ? (
                  <><span className="text-sm text-muted-foreground">Severity at least</span>
                    <select className={selectCls + ' w-32'} value={c.severity} onChange={(e) => updateCond(conditions, i, { ...c, severity: e.target.value as 'info' | 'warning' | 'critical' }, set)}>
                      {COND_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></>
                ) : c.type === 'meta_threshold' ? (
                  <><span className="text-sm text-muted-foreground">meta</span>
                    <Input className="w-40 font-mono" placeholder="cpu.usage" value={c.path} onChange={(e) => updateCond(conditions, i, { ...c, path: e.target.value }, set)} />
                    <select className={selectCls + ' w-20'} value={c.op} onChange={(e) => updateCond(conditions, i, { ...c, op: e.target.value as typeof c.op }, set)}>
                      {THRESHOLD_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    <Input className="w-28" placeholder="value" value={String(c.value)} onChange={(e) => { const n = Number(e.target.value); updateCond(conditions, i, { ...c, value: e.target.value !== '' && Number.isFinite(n) ? n : e.target.value }, set); }} /></>
                ) : (
                  <><span className="text-sm text-muted-foreground">Monitor</span>
                    <select className={selectCls + ' w-44'} value={c.monitorId} onChange={(e) => updateCond(conditions, i, { ...c, monitorId: e.target.value }, set)}>
                      <option value="">Select monitor…</option>
                      {monitors.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <span className="text-sm text-muted-foreground">is</span>
                    <select className={selectCls + ' w-28'} value={c.state} onChange={(e) => updateCond(conditions, i, { ...c, state: e.target.value as 'up' | 'down' | 'paused' }, set)}>
                      {MONITOR_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select></>
                )}
                <Button type="button" variant="ghost" size="icon" className="ml-auto" onClick={() => set({ conditions: conditions.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Actions */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Do (actions, in order)</p>
          <div className="flex flex-wrap gap-1 justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'notify', title: '', severity: 'warning' }] })}>+ Notify</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'connector_action', instanceId: '', kind: '', resourceId: '', actionId: '' }] })}>+ Connector action</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'connector_operation', instanceId: '', operationId: '' }] })}>+ Operation</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'pause_monitor', monitorId: '' }] })}>+ Pause monitor</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'resume_monitor', monitorId: '' }] })}>+ Resume monitor</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => set({ actions: [...actions, { type: 'webhook', url: '', method: 'POST', body: '' }] })}>+ Webhook</Button>
          </div>
        </div>
        {actions.length === 0 ? <p className="text-xs text-destructive">Add at least one action.</p> : (
          <div className="space-y-2">
            {actions.map((a, i) => (
              <ActionRow key={i} action={a} connectors={connectors} monitors={monitors} manifests={manifests} loadManifest={loadManifest}
                onChange={(na) => set({ actions: actions.map((x, j) => (j === i ? na : x)) })}
                onRemove={() => set({ actions: actions.filter((_, j) => j !== i) })} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function updateCond(conditions: RuleCondition[], i: number, next: RuleCondition, set: (p: Partial<AutomationRuleInput>) => void) {
  set({ conditions: conditions.map((c, j) => (j === i ? next : c)) });
}

const ACTION_LABEL: Record<RuleAction['type'], string> = {
  notify: 'Notify', connector_action: 'Connector action', connector_operation: 'Connector operation',
  pause_monitor: 'Pause monitor', resume_monitor: 'Resume monitor', webhook: 'Webhook',
};

/** Fetch a connector instance's resources of one kind (for the resource pickers). */
function useResources(instanceId: string | undefined, kind: string | undefined): ConnectorResource[] | null {
  const [list, setList] = useState<ConnectorResource[] | null>(null);
  useEffect(() => {
    if (!instanceId || !kind) { setList(null); return; }
    let cancelled = false;
    setList(null);
    api.get<ConnectorResource[]>(`/api/connectors/instances/${instanceId}/resources?kind=${encodeURIComponent(kind)}`)
      .then((r) => { if (!cancelled) setList(r); })
      .catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, [instanceId, kind]);
  return list;
}

/** A dropdown of the chosen connector+kind's actual resources, replacing the old free-text id box.
 *  Falls back to a manual id input when the kind can't be listed here, and always keeps an
 *  already-saved id selectable even if it's not in the current list. */
function ResourceSelect({ instanceId, kind, value, onChange }: {
  instanceId: string; kind: string; value: string; onChange: (v: string) => void;
}) {
  const list = useResources(instanceId || undefined, kind || undefined);
  if (!instanceId || !kind) return <select className={selectCls} disabled><option>Pick a connector and kind first…</option></select>;
  if (list === null) return <select className={selectCls} disabled><option>Loading resources…</option></select>;
  if (list.length === 0) return <Input placeholder="Resource id" value={value} onChange={(e) => onChange(e.target.value)} />;
  const known = list.some((r) => r.id === value);
  return (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select resource…</option>
      {list.map((r) => <option key={r.id} value={r.id}>{r.name}{r.status ? ` · ${r.status}` : ''}</option>)}
      {value && !known && <option value={value}>{value} (saved)</option>}
    </select>
  );
}

function ActionRow({ action, connectors, monitors, manifests, loadManifest, onChange, onRemove }: {
  action: RuleAction; connectors: ConnectorInstanceSummary[]; monitors: MonitorSummary[]; manifests: Record<string, ConnectorManifest>;
  loadManifest: (connectorId: string) => Promise<ConnectorManifest | null>;
  onChange: (a: RuleAction) => void; onRemove: () => void;
}) {
  const isConnector = action.type === 'connector_action' || action.type === 'connector_operation';
  const connectorId = isConnector ? connectors.find((c) => c.id === action.instanceId)?.connectorId : undefined;
  const manifest = connectorId ? manifests[connectorId] : undefined;
  useEffect(() => { if (connectorId) void loadManifest(connectorId); }, [connectorId, loadManifest]);

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-primary">{ACTION_LABEL[action.type]}</span>
        <Button type="button" variant="ghost" size="icon" onClick={onRemove}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>
      {action.type === 'notify' && (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_9rem] gap-2">
            <Input placeholder="Notification title" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} />
            <select className={selectCls + ' !mt-0'} value={action.severity ?? 'warning'}
              onChange={(e) => onChange({ ...action, severity: e.target.value as 'info' | 'warning' | 'critical' })}>
              {COND_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <Input placeholder="Body (optional)" value={action.body ?? ''} onChange={(e) => onChange({ ...action, body: e.target.value })} />
        </div>
      )}
      {action.type === 'connector_action' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <select className={selectCls} value={action.instanceId}
              onChange={(e) => onChange({ ...action, instanceId: e.target.value, kind: '', actionId: '', resourceId: '' })}>
              <option value="">Connector…</option>
              {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className={selectCls} value={action.kind} disabled={!action.instanceId}
              onChange={(e) => onChange({ ...action, kind: e.target.value, actionId: '', resourceId: '' })}>
              <option value="">Kind…</option>
              {(manifest?.resourceKinds ?? []).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <select className={selectCls} value={action.actionId} disabled={!action.kind}
              onChange={(e) => onChange({ ...action, actionId: e.target.value })}>
              <option value="">Action…</option>
              {(manifest?.resourceKinds.find((k) => k.id === action.kind)?.actions ?? []).map((ac) => <option key={ac.id} value={ac.id}>{ac.label}</option>)}
            </select>
          </div>
          <div>
            <Label className="text-xs">Resource</Label>
            <ResourceSelect instanceId={action.instanceId} kind={action.kind} value={action.resourceId}
              onChange={(v) => onChange({ ...action, resourceId: v })} />
          </div>
        </div>
      )}
      {action.type === 'connector_operation' && (() => {
        const op = manifest?.operations?.find((o) => o.id === action.operationId);
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <select className={selectCls} value={action.instanceId}
                onChange={(e) => onChange({ ...action, instanceId: e.target.value, operationId: '', resourceId: undefined, values: undefined })}>
                <option value="">Connector…</option>
                {connectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className={selectCls} value={action.operationId} disabled={!action.instanceId}
                onChange={(e) => onChange({ ...action, operationId: e.target.value, resourceId: undefined, values: undefined })}>
                <option value="">Operation…</option>
                {(manifest?.operations ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            {op?.scope === 'resource' && op.kind && (
              <div>
                <Label className="text-xs">Resource</Label>
                <ResourceSelect instanceId={action.instanceId} kind={op.kind} value={action.resourceId ?? ''}
                  onChange={(v) => onChange({ ...action, resourceId: v })} />
              </div>
            )}
            {op && op.fields.length > 0 && (
              <div className="rounded-md border border-border/60 bg-muted/20 p-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Parameters</p>
                <OperationFields instanceId={action.instanceId} operation={op}
                  values={action.values ?? {}} onChange={(values) => onChange({ ...action, values })} />
              </div>
            )}
          </div>
        );
      })()}
      {(action.type === 'pause_monitor' || action.type === 'resume_monitor') && (
        <select className={selectCls} value={action.monitorId} onChange={(e) => onChange({ ...action, monitorId: e.target.value })}>
          <option value="">Select monitor…</option>
          {monitors.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      )}
      {action.type === 'webhook' && (
        <div className="space-y-2">
          <div className="grid grid-cols-[6rem_1fr] gap-2">
            <select className={selectCls + ' !mt-0'} value={action.method ?? 'POST'} onChange={(e) => onChange({ ...action, method: e.target.value as 'GET' | 'POST' })}>
              <option value="POST">POST</option><option value="GET">GET</option>
            </select>
            <Input placeholder="https://hooks.example.com/…" value={action.url} onChange={(e) => onChange({ ...action, url: e.target.value })} />
          </div>
          {(action.method ?? 'POST') === 'POST' && (
            <>
              <textarea className="w-full min-h-[5rem] rounded-md border border-input bg-background/60 p-2 text-sm font-mono resize-y"
                placeholder={'{"text": "{{title}} ({{severity}})"}'} value={action.body ?? ''} onChange={(e) => onChange({ ...action, body: e.target.value })} spellCheck={false} />
              <p className="text-xs text-muted-foreground">Tokens: <code>{'{{title}}'}</code> <code>{'{{severity}}'}</code> <code>{'{{source}}'}</code> <code>{'{{detail}}'}</code> <code>{'{{kind}}'}</code> <code>{'{{ruleName}}'}</code></p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

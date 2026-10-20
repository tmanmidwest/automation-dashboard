import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, RefreshCw, Trash2, Upload, Unlink, AlertTriangle } from 'lucide-react';
import type {
  AgentGovernance,
  AssistantAgentView,
  ZumaAgentType,
  ZumaConnectionView,
  ZumaCriticality,
  ZumaEnvironment,
  ZumaOwnerRole,
} from '@cerebro/shared';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const selectCls = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

// Mirrors ZUMA_ENVIRONMENTS / ZUMA_CRITICALITIES / ZUMA_AGENT_TYPES (web imports types only from shared).
const ENVIRONMENTS: ZumaEnvironment[] = ['dev', 'test', 'staging', 'prod'];
const CRITICALITIES: ZumaCriticality[] = ['critical', 'high', 'medium', 'low'];
const AGENT_TYPES: ZumaAgentType[] = ['assistant', 'conversational', 'autonomous'];
const ROLES: ZumaOwnerRole[] = ['Business Owner', 'Technical Owner'];

const NEW_GOVERNANCE: Omit<AgentGovernance, 'environment'> = {
  criticality: null,
  agentType: 'assistant',
  owners: [],
  ownerTeamName: null,
  ownerTeamContact: null,
  labels: {},
};

const labelsToText = (labels: Record<string, string>) =>
  Object.entries(labels).map(([k, v]) => `${k}=${v}`).join('\n');

function textToLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * The agent editor's Governance card: the details Saviynt Zuma needs (environment, criticality,
 * owners, labels), saved with the agent, plus Register / Sync once the agent exists.
 */
export function AgentGovernanceCard({
  agentId,
  governance,
  zuma,
  onChange,
  onSave,
  onSynced,
}: {
  /** Undefined for an agent that isn't saved yet. */
  agentId?: string;
  governance: AgentGovernance | null;
  zuma?: AssistantAgentView['zuma'];
  onChange: (g: AgentGovernance | null) => void;
  /** Save the agent's pending edits; resolves null when saving failed. */
  onSave: () => Promise<AssistantAgentView | null>;
  onSynced: (view: AssistantAgentView) => void;
}) {
  const [conn, setConn] = useState<ZumaConnectionView | null>(null);
  const [labelsText, setLabelsText] = useState(labelsToText(governance?.labels ?? {}));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.get<ZumaConnectionView>('/api/assistant/zuma/connection').then(setConn).catch(() => setConn(null));
  }, []);
  // Reload the labels text when a different agent (or a freshly saved one) comes in.
  useEffect(() => setLabelsText(labelsToText(governance?.labels ?? {})), [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<AgentGovernance>) => governance && onChange({ ...governance, ...patch });

  async function run(kind: 'sync' | 'status' | 'unlink') {
    if (!agentId) return;
    if (kind === 'unlink' && !window.confirm(
      'Forget this agent\'s Zuma registration in Cerebro? The agent stays registered in Saviynt (retire it there). Registering again creates a new entry unless Saviynt matches it.',
    )) return;
    setBusy(kind);
    setMsg(null);
    try {
      let view: AssistantAgentView;
      if (kind === 'sync') {
        // Push what's on screen, not the last saved version.
        if (!(await onSave())) return;
        view = await api.post<AssistantAgentView>(`/api/assistant/zuma/agents/${agentId}/sync`);
        setMsg({ ok: true, text: zuma?.agentId ? 'Synced to Zuma.' : 'Registered with Zuma.' });
      } else if (kind === 'status') {
        view = await api.post<AssistantAgentView>(`/api/assistant/zuma/agents/${agentId}/status`);
      } else {
        view = await api.delete<AssistantAgentView>(`/api/assistant/zuma/agents/${agentId}`);
      }
      onSynced(view);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Zuma request failed.' });
    } finally {
      setBusy(null);
    }
  }

  const owners = governance?.owners ?? [];
  const registered = !!zuma?.agentId;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Governance</CardTitle>
        <CardDescription>
          Details for the Saviynt Zuma agent registry. Saved with the agent; sent to Zuma when you register or sync.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Environment</Label>
            <select
              className={selectCls}
              value={governance?.environment ?? ''}
              onChange={(e) => {
                const env = e.target.value as ZumaEnvironment | '';
                if (!env) onChange(null);
                else onChange(governance ? { ...governance, environment: env } : { ...NEW_GOVERNANCE, environment: env });
              }}
            >
              <option value="">Not set (not registered)</option>
              {ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Criticality</Label>
            <select className={selectCls} disabled={!governance} value={governance?.criticality ?? ''}
              onChange={(e) => set({ criticality: (e.target.value || null) as ZumaCriticality | null })}>
              <option value="">Not set</option>
              {CRITICALITIES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>Agent type</Label>
            <select className={selectCls} disabled={!governance} value={governance?.agentType ?? ''}
              onChange={(e) => set({ agentType: (e.target.value || null) as ZumaAgentType | null })}>
              <option value="">Not set</option>
              {AGENT_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>

        {governance && (
          <>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Owner team</Label>
                <Input value={governance.ownerTeamName ?? ''} placeholder="e.g. Identity Engineering"
                  onChange={(e) => set({ ownerTeamName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label>Owner team contact</Label>
                <Input value={governance.ownerTeamContact ?? ''} placeholder="e.g. iam-team@example.com"
                  onChange={(e) => set({ ownerTeamContact: e.target.value })} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Owners</Label>
              <p className="text-xs text-muted-foreground">
                Each email must already exist as an identity in your Saviynt tenant, or Zuma rejects the registration.
              </p>
              {owners.map((o, i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_12rem_auto]">
                  <Input value={o.name} placeholder="Name"
                    onChange={(e) => set({ owners: owners.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input value={o.email} placeholder="Email" type="email"
                    onChange={(e) => set({ owners: owners.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })} />
                  <select className={selectCls} value={o.role}
                    onChange={(e) => set({ owners: owners.map((x, j) => (j === i ? { ...x, role: e.target.value as ZumaOwnerRole } : x)) })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <Button variant="outline" size="sm" title="Remove owner"
                    onClick={() => set({ owners: owners.filter((_, j) => j !== i) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm"
                onClick={() => set({ owners: [...owners, { name: '', email: '', role: owners.length ? 'Technical Owner' : 'Business Owner' }] })}>
                <Plus className="h-4 w-4" /> Add owner
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label>Labels</Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono min-h-[5rem]"
                value={labelsText}
                placeholder={'cost-center=it-ops\ndata-class=internal'}
                onChange={(e) => {
                  setLabelsText(e.target.value);
                  set({ labels: textToLabels(e.target.value) });
                }}
              />
              <p className="text-xs text-muted-foreground">
                One <span className="font-mono">key=value</span> per line. Lowercase letters, digits, - and _ only.
              </p>
            </div>
          </>
        )}

        <div className="rounded-md border border-input p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium flex-1 min-w-0">
              Saviynt Zuma:{' '}
              {registered ? (
                <>
                  registered <span className="font-mono text-xs">{zuma!.agentId}</span>
                  {zuma!.status && <span className="ml-2 rounded bg-primary/15 text-primary px-1.5 py-0.5 text-xs">{zuma!.status}</span>}
                </>
              ) : (
                <span className="text-muted-foreground">not registered</span>
              )}
            </p>
            {agentId && (
              <>
                <Button size="sm" onClick={() => run('sync')} disabled={!!busy || !governance || !conn?.ready}>
                  <Upload className={cn('h-4 w-4', busy === 'sync' && 'animate-pulse')} /> {registered ? 'Save and sync' : 'Save and register'}
                </Button>
                {registered && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => run('status')} disabled={!!busy || !conn?.ready} title="Re-read the status from Zuma">
                      <RefreshCw className={cn('h-4 w-4', busy === 'status' && 'animate-spin')} /> Status
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => run('unlink')} disabled={!!busy} title="Forget the registration in Cerebro">
                      <Unlink className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          {zuma?.syncedAt && (
            <p className="text-xs text-muted-foreground">
              Last synced {new Date(zuma.syncedAt).toLocaleString()}
              {zuma.outOfDate && <span className="text-amber-500"> · changed since then, sync to update Zuma</span>}
            </p>
          )}
          {zuma?.ownersOrLabelsChanged && (
            <p className="text-xs text-amber-500 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              Owners, owner team or labels changed after registration. Zuma's API only takes these at registration, so update them in Saviynt.
            </p>
          )}
          {!agentId && <p className="text-xs text-muted-foreground">Save the agent first, then register it.</p>}
          {agentId && conn && !conn.ready && (
            <p className="text-xs text-muted-foreground">
              Set up the connection in <Link className="underline" to="/settings/zuma">Settings → Saviynt Zuma</Link> to register agents.
            </p>
          )}
          {agentId && conn?.ready && !governance && (
            <p className="text-xs text-muted-foreground">Pick an environment to register this agent.</p>
          )}
          {zuma?.lastError && !msg && <p className="text-xs text-red-500">{zuma.lastError}</p>}
          {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-500' : 'text-red-500')}>{msg.text}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ConnectorOperation, ConnectorOption, SecretSummary } from '@cerebro/shared';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const selectCls = 'mt-1 flex h-9 w-full rounded-md border border-input bg-background/60 px-2 text-sm';

/** Vault secrets of a given kind as dropdown options (for `optionsSource: 'vault:<kind>'`). */
async function vaultSecretOptions(kind: string): Promise<ConnectorOption[]> {
  const secrets = await api.get<SecretSummary[]>('/api/secrets').catch(() => [] as SecretSummary[]);
  const opts = secrets.filter((s) => s.kind === kind).map((s) => ({ value: s.key, label: s.label || s.key }));
  return [{ value: '', label: '— none —' }, ...opts];
}

/**
 * Renders a connector operation's form fields into a plain `values` object — the same
 * field model as OperationDialog (static + dynamic `optionsSource` options, `showWhen`
 * visibility, `dependsOn` refresh), but without the run/job machinery. Used by the
 * Automations rule builder so a `connector_operation` action can set its parameters.
 */
export function OperationFields({ instanceId, operation, values, onChange }: {
  instanceId: string;
  operation: ConnectorOperation;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
}) {
  const [optionsMap, setOptionsMap] = useState<Record<string, ConnectorOption[]>>({});
  const setField = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  const optionFields = useMemo(() => operation.fields.filter((f) => f.optionsSource), [operation]);
  const depFor = (d: string) => values[d];
  const depsSignature = JSON.stringify(optionFields.map((f) => (f.dependsOn ?? []).map((d) => depFor(d))));

  // Load dynamic dropdown options and refresh when a dependency value changes.
  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;
    optionFields.forEach(async (f) => {
      const deps = f.dependsOn ?? [];
      if (deps.some((d) => !depFor(d))) { setOptionsMap((m) => ({ ...m, [f.key]: [] })); return; }
      try {
        const opts = f.optionsSource!.startsWith('vault:')
          ? await vaultSecretOptions(f.optionsSource!.slice('vault:'.length))
          : await api.post<ConnectorOption[]>(`/api/connectors/instances/${instanceId}/options`, { sourceId: f.optionsSource, values });
        if (!cancelled) setOptionsMap((m) => ({ ...m, [f.key]: opts }));
      } catch { if (!cancelled) setOptionsMap((m) => ({ ...m, [f.key]: [] })); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsSignature, instanceId, operation.id]);

  const visible = (f: ConnectorOperation['fields'][number]) =>
    !f.showWhen || values[f.showWhen.field] === f.showWhen.equals;

  if (operation.fields.length === 0) return null;

  return (
    <div className="space-y-2">
      {operation.fields.filter(visible).map((f) => {
        const opts = f.options ?? optionsMap[f.key] ?? [];
        if (f.type === 'boolean') {
          return (
            <label key={f.key} className="flex items-center gap-2 cursor-pointer text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={values[f.key] === true} onChange={(e) => setField(f.key, e.target.checked)} />
              <span>{f.label}</span>
            </label>
          );
        }
        if (f.type === 'select') {
          return (
            <div key={f.key}>
              <Label className="text-xs">{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
              <select className={selectCls} value={String(values[f.key] ?? '')} onChange={(e) => setField(f.key, e.target.value)}>
                <option value="">{opts.length ? 'Select…' : '(none available)'}</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
            </div>
          );
        }
        if (f.type === 'textarea') {
          return (
            <div key={f.key}>
              <Label className="text-xs">{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
              <textarea rows={3} value={String(values[f.key] ?? '')} placeholder={f.placeholder}
                onChange={(e) => setField(f.key, e.target.value)} spellCheck={false}
                className="mt-1 block w-full rounded-md border border-input bg-background/60 px-2 py-1.5 text-sm font-mono resize-y" />
              {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
            </div>
          );
        }
        const inputType = f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
        return (
          <div key={f.key}>
            <Label className="text-xs">{f.label}{f.required && <span className="text-primary"> *</span>}</Label>
            <Input type={inputType} value={String(values[f.key] ?? '')} placeholder={f.placeholder}
              onChange={(e) => setField(f.key, f.type === 'number' ? Number(e.target.value) : e.target.value)} />
            {f.help && <p className="text-xs text-muted-foreground mt-1">{f.help}</p>}
          </div>
        );
      })}
    </div>
  );
}

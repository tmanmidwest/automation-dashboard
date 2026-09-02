import type { ConnectorConfigField } from '@cerebro/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Renders one manifest-declared config field (connector setup, monitor form).
 * Secret fields show a "saved — blank keeps" hint when a value already exists.
 */
export function ConfigField({
  field, value, secretSet, disabled, onChange,
}: {
  field: ConnectorConfigField;
  value: unknown;
  secretSet?: boolean;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-3 cursor-pointer">
        <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]"
          checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="text-sm">{field.label}{field.help && <span className="text-muted-foreground font-normal"> — {field.help}</span>}</span>
      </label>
    );
  }
  if (field.type === 'select') {
    return (
      <div>
        <Label>{field.label}</Label>
        <select className="flex h-10 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
          value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => <option key={o.value} value={o.value} className="bg-background">{o.label}</option>)}
        </select>
        {field.help && <p className="text-xs text-muted-foreground mt-1">{field.help}</p>}
      </div>
    );
  }
  if (field.type === 'textarea') {
    return (
      <div>
        <Label>{field.label}</Label>
        <textarea
          className="flex min-h-[80px] w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={String(value ?? '')} disabled={disabled} required={field.required}
          placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        {field.help && <p className="text-xs text-muted-foreground mt-1">{field.help}</p>}
      </div>
    );
  }
  const inputType = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
  return (
    <div>
      <Label>
        {field.label}
        {field.secret && secretSet && <span className="text-muted-foreground font-normal"> (saved — blank keeps)</span>}
      </Label>
      <Input type={inputType} value={String(value ?? '')} disabled={disabled}
        required={field.required && !(field.secret && secretSet)}
        placeholder={field.secret && secretSet ? '••••••••' : field.placeholder}
        onChange={(e) => onChange(field.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} />
      {field.help && <p className="text-xs text-muted-foreground mt-1">{field.help}</p>}
    </div>
  );
}

/** Shared bits for the notification settings cards. */

export type Severity = 'info' | 'warning' | 'critical';

export const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];

export function SeveritySelect({
  value,
  disabled,
  onChange,
}: {
  value: Severity;
  disabled: boolean;
  onChange: (v: Severity) => void;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Severity)}
      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm disabled:opacity-50"
    >
      {SEVERITIES.map((s) => (
        <option key={s.value} value={s.value} className="bg-background">
          {s.label}
        </option>
      ))}
    </select>
  );
}

/** Enable checkbox used in each channel card header. */
export function EnableToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer shrink-0">
      <input
        type="checkbox"
        className="h-4 w-4 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm">Enabled</span>
    </label>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <span className="lcars-accentbar mt-2" aria-hidden />
          <h1 className="font-lcars text-3xl font-semibold leading-none text-balance">{title}</h1>
        </div>
        {actions && <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">{actions}</div>}
      </div>
      {description && <p className="text-sm text-muted-foreground mt-1.5 max-w-3xl">{description}</p>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="flex items-start gap-3 min-w-0">
        <span className="lcars-accentbar mt-2" aria-hidden />
        <div className="min-w-0">
          <h1 className="font-lcars text-3xl font-semibold leading-none text-balance">{title}</h1>
          {description && <p className="text-sm text-muted-foreground mt-1.5">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

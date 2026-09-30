import { useEffect } from 'react';
import { usePageTitleSetter } from './PageTitleContext';

export function PageHeader({ title, description, actions }: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  // The title lives in the AppShell's LCARS sweep (the blue bar), not in-page.
  // Publish it there; clear it on unmount so a title-less page doesn't inherit
  // a stale name.
  const setPageTitle = usePageTitleSetter();
  useEffect(() => {
    setPageTitle(title);
    return () => setPageTitle('');
  }, [title, setPageTitle]);

  // Nothing to render if this page is title-only (no description, no actions).
  if (!description && !actions) return null;

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-6">
      <div className="flex items-start gap-3 min-w-0">
        <span className="lcars-accentbar mt-1" aria-hidden />
        {description && <p className="text-sm text-muted-foreground max-w-3xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

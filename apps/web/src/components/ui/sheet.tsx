import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';

/** The LCARS side-rail: three color bars with rounded outer ends. */
function LcarsRail() {
  return (
    <div className="w-12 shrink-0 flex flex-col gap-1.5 py-0" aria-hidden>
      <div className="h-16 rounded-l-[22px]" style={{ background: 'hsl(var(--accent))' }} />
      <div className="flex-1 min-h-[24px] rounded-l-[22px]" style={{ background: 'hsl(var(--secondary))' }} />
      <div className="h-24 rounded-l-[22px]" style={{ background: 'hsl(var(--primary))' }} />
    </div>
  );
}

/** A right-side LCARS slide-over panel with a dimmed backdrop. */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="absolute right-0 top-0 h-full w-full max-w-md flex gap-1.5 pl-2 animate-slide-in-right">
        <LcarsRail />
        <div className="flex-1 min-w-0 h-full flex flex-col bg-card border-l border-border shadow-2xl">
          <div className="flex items-start justify-between gap-4 p-5 border-b border-border">
            <div className="flex items-start gap-3 min-w-0">
              <span className="lcars-accentbar mt-1.5" aria-hidden />
              <div className="min-w-0">
                <h2 className="font-lcars text-xl font-semibold leading-none truncate">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1.5">{description}</p>}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="p-5 border-t border-border">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

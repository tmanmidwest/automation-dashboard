import { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';

/** The LCARS side-rail: three color bars with rounded outer ends. */
function LcarsRail({ className }: { className?: string }) {
  return (
    <div className={`shrink-0 flex flex-col gap-1.5 ${className ?? ''}`} aria-hidden>
      <div className="h-14 rounded-l-[22px]" style={{ background: 'hsl(var(--accent))' }} />
      <div className="flex-1 min-h-[24px] rounded-l-[22px]" style={{ background: 'hsl(var(--secondary))' }} />
      <div className="h-20 rounded-l-[22px]" style={{ background: 'hsl(var(--primary))' }} />
    </div>
  );
}

/** A centered LCARS modal dialog with a dimmed backdrop. */
export function Dialog({
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
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/60 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-lg max-h-[90vh] flex gap-1.5 animate-fade-in">
        <LcarsRail className="w-12" />
        <div className="flex-1 min-w-0 flex flex-col rounded-r-xl border border-border bg-card shadow-2xl overflow-hidden">
          <div className="flex items-start justify-between gap-4 p-5 border-b border-border">
            <div className="flex items-start gap-3 min-w-0">
              <span className="lcars-accentbar mt-1.5" aria-hidden />
              <div className="min-w-0">
                <h2 className="font-lcars text-xl font-semibold leading-none">{title}</h2>
                {description && <p className="text-sm text-muted-foreground mt-1.5">{description}</p>}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></Button>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{children}</div>
          {footer && <div className="p-5 border-t border-border flex justify-end gap-2">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

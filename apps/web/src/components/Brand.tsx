import { cn } from '@/lib/utils';

/** The Cerebro wordmark + glyph (a stylized neural/brain node). */
export function Brand({ className, showText = true }: { className?: string; showText?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="h-7 w-7 drop-shadow-[0_0_8px_hsl(var(--primary)/0.6)]" aria-hidden>
        <defs>
          <linearGradient id="cb" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(var(--accent))" />
          </linearGradient>
        </defs>
        <circle cx="16" cy="16" r="13" fill="none" stroke="url(#cb)" strokeWidth="1.5" opacity="0.5" />
        <circle cx="16" cy="16" r="4" fill="url(#cb)" />
        <g stroke="url(#cb)" strokeWidth="1.4" strokeLinecap="round">
          <line x1="16" y1="16" x2="7" y2="9" />
          <line x1="16" y1="16" x2="25" y2="9" />
          <line x1="16" y1="16" x2="8" y2="24" />
          <line x1="16" y1="16" x2="24" y2="24" />
        </g>
        <g fill="hsl(var(--accent))">
          <circle cx="7" cy="9" r="1.8" />
          <circle cx="25" cy="9" r="1.8" />
          <circle cx="8" cy="24" r="1.8" />
          <circle cx="24" cy="24" r="1.8" />
        </g>
      </svg>
      {showText && (
        <span className="text-lg font-bold tracking-tight bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
          CEREBRO
        </span>
      )}
    </div>
  );
}

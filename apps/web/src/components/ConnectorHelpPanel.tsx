import { useState } from 'react';
import { ExternalLink, KeyRound, ListChecks, Info, AlertTriangle, Copy, Check, FileCode2 } from 'lucide-react';
import type { ConnectorHelp, ConnectorCodeSample } from '@cerebro/shared';
import { Card, CardContent } from './ui/card';
import { cn } from '@/lib/utils';

function CodeSample({ sample }: { sample: ConnectorCodeSample }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sample.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — user can select manually */ }
  };
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <FileCode2 className="h-4 w-4 text-primary" />
        <p className="font-medium">{sample.title}</p>
        {sample.language && <span className="text-[10px] font-mono uppercase tracking-wider rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{sample.language}</span>}
        <button onClick={copy} className={cn('ml-auto inline-flex items-center gap-1 text-xs rounded-md border border-border px-2 py-1 transition-colors', copied ? 'text-emerald-400 border-emerald-500/40' : 'text-muted-foreground hover:text-foreground hover:border-primary/40')}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {sample.description && <p className="text-xs text-muted-foreground mb-2">{sample.description}</p>}
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-background/70 p-3 text-xs leading-relaxed">
        <code className="font-mono text-muted-foreground">{sample.code}</code>
      </pre>
    </div>
  );
}

/** Renders a connector's setup reference: overview, steps, required permissions, links, notes. */
export function ConnectorHelpPanel({ help }: { help?: ConnectorHelp }) {
  if (!help) return null;
  return (
    <Card className="bg-card/60">
      <CardContent className="pt-6 space-y-5 text-sm">
        {help.overview && (
          <div className="flex gap-3">
            <Info className="h-4 w-4 mt-0.5 text-accent shrink-0" />
            <p className="text-muted-foreground">{help.overview}</p>
          </div>
        )}

        {help.setupSteps && help.setupSteps.length > 0 && (
          <div>
            <p className="font-medium flex items-center gap-2 mb-2"><ListChecks className="h-4 w-4 text-primary" /> Setup steps</p>
            <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground marker:text-primary/70">
              {help.setupSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
        )}

        {help.requiredPermissions && help.requiredPermissions.length > 0 && (
          <div>
            <p className="font-medium flex items-center gap-2 mb-2"><KeyRound className="h-4 w-4 text-primary" /> Required permissions</p>
            <ul className="space-y-1.5">
              {help.requiredPermissions.map((p, i) => (
                <li key={i} className="flex gap-2 text-muted-foreground">
                  <span className="text-primary/70 mt-1.5 h-1 w-1 rounded-full bg-current shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {help.codeSamples && help.codeSamples.length > 0 && (
          <div className="space-y-4">
            {help.codeSamples.map((s, i) => <CodeSample key={i} sample={s} />)}
          </div>
        )}

        {help.notes && (
          <div className="flex gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-400 shrink-0" />
            <p className="text-amber-200/90">{help.notes}</p>
          </div>
        )}

        {help.referenceLinks && help.referenceLinks.length > 0 && (
          <div>
            <p className="font-medium mb-2">Reference</p>
            <div className="flex flex-col gap-1.5">
              {help.referenceLinks.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-accent hover:underline w-fit">
                  <ExternalLink className="h-3.5 w-3.5" /> {l.label}
                </a>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

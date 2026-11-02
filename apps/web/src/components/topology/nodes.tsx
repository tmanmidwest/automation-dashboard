import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  Box, Boxes, ChevronDown, ChevronRight, Globe, Layers, Link2, Network, Router, Server, ServerCog, Smartphone, Wifi,
} from 'lucide-react';
import type { TopoNode, TopoNodeType, TopoStatus } from '@cerebro/shared';
import { cn } from '@/lib/utils';
import type { VNode } from './views';

export const TYPE_ICON: Record<TopoNodeType, React.ComponentType<{ className?: string }>> = {
  internet: Globe,
  gateway: Router,
  switch: Network,
  ap: Wifi,
  network: Layers,
  host: Server,
  pve_node: ServerCog,
  stack: Boxes,
  container: Box,
  dns_name: Link2,
  proxy: Link2,
  port_forward: Link2,
};

export const TYPE_LABEL: Record<TopoNodeType, string> = {
  internet: 'Internet',
  gateway: 'Gateway',
  switch: 'Switch',
  ap: 'Access point',
  network: 'Network',
  host: 'Host',
  pve_node: 'Proxmox node',
  stack: 'Stack',
  container: 'Container',
  dns_name: 'Hostname',
  proxy: 'Proxy',
  port_forward: 'Port forward',
};

export const STATUS_DOT: Record<TopoStatus, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  down: 'bg-red-500',
  off: 'bg-muted-foreground/50',
  unknown: 'bg-slate-500/60',
};

const STATUS_BORDER: Record<TopoStatus, string> = {
  ok: 'border-border',
  warn: 'border-amber-400/70',
  down: 'border-red-500/80',
  off: 'border-border',
  unknown: 'border-border border-dashed',
};

export function iconFor(n: TopoNode) {
  if (n.type === 'host' && !n.infra) return Smartphone;
  return TYPE_ICON[n.type];
}

export interface TopoData extends Record<string, unknown> {
  v: VNode;
  /** Card title (containers show "stack / service" outside the compute view). */
  title: string;
  selected: boolean;
  dimmed: boolean;
  onToggle: (id: string) => void;
}

export type TopoFlowNode = Node<TopoData>;

const handles = (
  <>
    <Handle type="target" position={Position.Top} className="!opacity-0 !pointer-events-none" />
    <Handle type="source" position={Position.Bottom} className="!opacity-0 !pointer-events-none" />
    <Handle id="l" type="target" position={Position.Left} className="!opacity-0 !pointer-events-none" />
    <Handle id="r" type="source" position={Position.Right} className="!opacity-0 !pointer-events-none" />
  </>
);

/** A single machine / device / name, or a collapsed group shown as a summary tile. */
export const TopoCard = memo(function TopoCard({ data }: NodeProps<TopoFlowNode>) {
  const { v, selected, dimmed, title, onToggle } = data;
  const n = v.node;
  const Icon = iconFor(n);
  const sum = v.summary;
  const unit = n.type === 'network' ? 'machine' : 'container';
  return (
    <div
      className={cn(
        'h-full w-full rounded-lg border bg-card px-3 py-2 flex flex-col justify-center gap-1.5 shadow-sm transition-opacity',
        STATUS_BORDER[n.status],
        sum && 'border-secondary/70 bg-secondary/10 cursor-pointer hover:border-primary/70',
        selected && 'ring-2 ring-primary border-primary',
        (dimmed || v.context) && 'opacity-35',
        n.type === 'internet' && 'bg-secondary/40',
      )}
      title={sum ? 'Click to open' : `${TYPE_LABEL[n.type]} · ${n.label}`}
    >
      {handles}
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="relative shrink-0">
          <div className="h-8 w-8 rounded-md bg-muted grid place-items-center"><Icon className="h-4 w-4 text-foreground/80" /></div>
          <span className={cn('absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card', STATUS_DOT[n.status])} />
        </div>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-[14px] font-medium truncate">{title}</p>
          <p className="text-[12px] text-muted-foreground truncate">{n.sublabel ?? (n.roles.join(' · ') || TYPE_LABEL[n.type])}</p>
        </div>
        {v.collapsed && (
          <button
            className="nodrag shrink-0 rounded p-1 hover:bg-primary/20 text-muted-foreground"
            onClick={(e) => { e.stopPropagation(); onToggle(n.id); }}
            title="Open"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
      {sum && (
        <div className="flex flex-wrap gap-1 text-[11px] leading-none">
          <span className="rounded bg-muted px-1.5 py-1 tabular-nums">{sum.machines} {unit}{sum.machines === 1 ? '' : 's'}</span>
          {sum.down > 0 && <span className="rounded bg-red-500/20 text-red-300 px-1.5 py-1 tabular-nums">{sum.down} down</span>}
          {sum.warn > 0 && <span className="rounded bg-amber-400/20 text-amber-300 px-1.5 py-1 tabular-nums">{sum.warn} warning</span>}
          {sum.exposed > 0 && <span className="rounded bg-accent/20 text-accent px-1.5 py-1 tabular-nums">{sum.exposed} exposed</span>}
          {sum.unknown > 0 && <span className="rounded border border-dashed border-muted-foreground/50 text-muted-foreground px-1.5 py-1 tabular-nums">{sum.unknown} unknown</span>}
        </div>
      )}
    </div>
  );
});

/** An expanded group: a VLAN, a Docker host, or a stack, drawn as a labelled box. */
export const TopoGroup = memo(function TopoGroup({ data }: NodeProps<TopoFlowNode>) {
  const { v, selected, dimmed, title, onToggle } = data;
  const n = v.node;
  const Icon = iconFor(n);
  return (
    <div
      className={cn(
        'h-full w-full rounded-xl border-2 bg-muted/20 transition-opacity',
        n.type === 'network' ? 'border-secondary/70' : n.type === 'stack' ? 'border-accent/40' : 'border-border',
        n.status === 'down' && 'border-red-500/70',
        selected && 'ring-2 ring-primary',
        dimmed && 'opacity-40',
      )}
    >
      {handles}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border/60">
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT[n.status])} />
        <span className="text-[13px] font-semibold truncate">{title}</span>
        <span className="text-[11px] text-muted-foreground truncate">{n.sublabel}</span>
        <button
          className="nodrag ml-auto shrink-0 rounded p-0.5 hover:bg-muted text-muted-foreground"
          onClick={(e) => { e.stopPropagation(); onToggle(n.id); }}
          title="Collapse"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});

export const nodeTypes = { card: TopoCard, group: TopoGroup };
